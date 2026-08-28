import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { GameService } from "../game/game.service";
import {
  LLM_OLLAMA,
  LLM_GOOGLE,
  llmMaxDuplicateGuesses,
  llmMaxFailedGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmGoogleRateLimitFallbackSeconds,
  llmTemperature,
} from "../../strategies";
import { Guess, GuessResult, GuessSource } from "./entities/guess.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
import {
  SolvePrompt,
  SolvePromptType,
  SolvePromptStatus,
  SolvePromptIssueTag,
} from "./entities/solve-prompt.entity";
import { StrategyRun, StrategyRunStatus, TERMINAL_STATUSES } from "./entities/strategy-run.entity";
import { OrchestratorService, type ChatMessage, type SolveErrorCode } from "./orchestrator.service";
import { SupportedModelService } from "../supported-model/supported-model.service";
import { StrategyRunStore } from "./strategy-run-store.service";
import { GoogleRateLimitHoldService } from "./google-rate-limit-hold.service";
import { firstCombination } from "./combinatorics";
import { GROUP_SIZE, parseGroupsSection } from "./parse-groups-section";

const MODEL_ERROR_RETRY_BASE_DELAY_MS = 1000;
const MODEL_ERROR_RETRY_MAX_DELAY_MS = 300000;

/**
 * Mutable state threaded through one runLlmStrategy call's while loop —
 * bundled into one object (rather than a dozen individual `let`s) so
 * evaluateProposals/classifyFailedCall below can share and update it by
 * reference instead of each needing to return updated primitives that the
 * caller then has to reassign.
 */
interface LlmRunLoopState {
  guessCount: number;
  duplicateCount: number;
  failedGuessCount: number;
  malformedCount: number;
  consecutiveModelErrors: number;
  // Set by classifyFailedCall for a "rate_limited" hit — the run loop's
  // post-flush wait step checks this before the model-error backoff, and
  // resets it to null after waiting. Never counts toward any failure
  // threshold; a rate_limited hit is never treated as a failure at all.
  rateLimitWaitMs: number | null;
  // Groups confirmed correct — used to build RETRY prompts.
  lockedInGroups: string[][];
  // The last failed guess — used to build RETRY prompts.
  lastFailedGuess: { items: string[]; result: string } | null;
  priorGuesses: { words: string[]; result: GuessResult }[];
}

export function buildInitialPrompt(items: string[], N: number): string {
  const totalItems = N * 4;

  return [
    `You are an expert solver for the NYT Connections puzzle.`,
    ``,
    `Task:`,
    `Analyze the ${totalItems} provided items and group them into exactly ${N} distinct sets of 4 items each, where every set shares a clear, logical category or connection.`,
    ``,
    `Items:`,
    items.join(", "),
    ``,
    `Rules:`,
    `1. Use EVERY item from the list above EXACTLY ONCE.`,
    `2. Do NOT add new words, alter spellings, or substitute items.`,
    `3. Every group MUST contain EXACTLY 4 items.`,
    ``,
    `Then produce your final answer using EXACTLY the format below. Output nothing before ### GROUPS and nothing after the last line of ### ANSWER.`,
    ``,
    `### GROUPS`,
    ...Array.from(
      { length: N },
      (_, i) =>
        `#### Group ${i + 1}\nCategory: <short category name>\nWords: <ITEM1>, <ITEM2>, <ITEM3>, <ITEM4>\n`,
    ),
    `### ANSWER`,
    ...Array.from({ length: N }, () => `<ITEM1>, <ITEM2>, <ITEM3>, <ITEM4>`),
  ].join("\n");
}

export function buildRetryPrompt(
  remainingItems: string[],
  lockedInGroups: string[][],
  lastFailedGuess: { items: string[]; result: string },
  N: number,
): string {
  const totalRemainingItems = N * 4;

  const parts = [
    `You are an expert solver for the NYT Connections puzzle.`,
    ``,
    `Feedback on Previous Guess:`,
    `- Guess submitted: ${lastFailedGuess.items.join(", ")}`,
    `- Result: ${lastFailedGuess.result}`,
    `- Guidance: ${
      lastFailedGuess.result.toLowerCase() === "one away" ||
      lastFailedGuess.result.toLowerCase() === "offby1"
        ? "Exactly 3 of these 4 items belong together in a category, but 1 item does not belong."
        : "These 4 items do NOT all belong to the same category."
    }`,
  ];

  if (lockedInGroups.length > 0) {
    parts.push(
      ``,
      `Already Solved Groups (Do NOT include these items in your proposals):`,
      ...lockedInGroups.map((group, idx) => `- Solved Group ${idx + 1}: ${group.join(", ")}`),
    );
  }

  parts.push(
    ``,
    `Task:`,
    `Analyze the remaining ${totalRemainingItems} items and group them into exactly ${N} distinct sets of 4 items each.`,
    ``,
    `Remaining Items:`,
    remainingItems.join(", "),
    ``,
    `Rules:`,
    `1. Use EVERY item from the remaining list above EXACTLY ONCE.`,
    `2. Do NOT re-submit the failed guess (${lastFailedGuess.items.join(", ")}).`,
    `3. Do NOT use items from the already solved groups.`,
    `4. Every group MUST contain EXACTLY 4 items.`,
    ``,
    `Then produce your final answer using EXACTLY the format below. Output nothing before ### GROUPS and nothing after the last line of ### ANSWER.`,
    ``,
    `### GROUPS`,
    ...Array.from(
      { length: N },
      (_, i) =>
        `#### Group ${i + 1}\nCategory: <short category name>\nWords: <ITEM1>, <ITEM2>, <ITEM3>, <ITEM4>\n`,
    ),
    `### ANSWER`,
    ...Array.from({ length: N }, () => `<ITEM1>, <ITEM2>, <ITEM3>, <ITEM4>`),
  );

  return parts.join("\n");
}

/**
 * Iterative LLM strategy runner using the unified AI Assist prompt flow.
 * Each step sends the full conversation history to the orchestrator's
 * /solve-assist endpoint, which calls generateText and parses the ANSWER:
 * section. The runner creates 4 LlmProposal entries per prompt (one per
 * parsed group), submits the first as a guess, and builds the next prompt
 * (INITIAL or RETRY) based on the guess outcome.
 */
@Injectable()
export class LlmStrategyRunner {
  constructor(
    @Inject(StrategyRunStore) private readonly store: StrategyRunStore,
    @InjectRepository(Guess) private readonly guessRepo: Repository<Guess>,
    @InjectRepository(SolvePrompt)
    private readonly solvePromptRepo: Repository<SolvePrompt>,
    @Inject(OrchestratorService) private readonly orchestratorService: OrchestratorService,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
    @Inject(GoogleRateLimitHoldService) private readonly rpdHold: GoogleRateLimitHoldService,
  ) {}

  async runLlmStrategy(puzzleId: number, strategyName: string, trialNumber = 0, model?: string) {
    // The strategy name alone determines the provider (there's no per-run
    // choice of provider today, only of model within it) — resolved once so
    // every orchestrator call for this run tells it which client to use.
    const provider =
      strategyName === LLM_OLLAMA ? "ollama" : strategyName === LLM_GOOGLE ? "google" : "openai";

    const contextWindow = model
      ? await this.supportedModelService.getContextWindow(strategyName, model)
      : null;

    const { run, puzzle } = await this.store.loadOrCreateRun(
      puzzleId,
      strategyName,
      trialNumber,
      model,
      contextWindow,
    );

    if (TERMINAL_STATUSES.has(run.status)) {
      return {
        status: run.status,
        guessCount: await this.store.countGuesses(run.id),
      };
    }

    // Top-gate: an llm-google run whose model is currently out of daily
    // quota parks immediately — one indexed read instead of a doomed Google
    // call. The google-rpd-resume sweep re-dispatches it after the reset.
    if (
      strategyName === LLM_GOOGLE &&
      model &&
      (await this.rpdHold.isHeld(strategyName, model))
    ) {
      run.status = StrategyRunStatus.RATE_LIMITED_DAILY;
      run.finishedAt = new Date();
      await this.store.saveRun(run);
      return {
        status: run.status,
        guessCount: await this.store.countGuesses(run.id),
      };
    }

    // Rebuild state from flushed guesses so a worker restart mid-run resumes
    // with the same conversation context.
    const priorGuesses = (await this.loadLlmGuessesForRun(run.id)).map((guess) => ({
      words: guess.words,
      result: guess.result,
    }));

    const state: LlmRunLoopState = {
      guessCount: priorGuesses.length,
      duplicateCount: priorGuesses.filter((guess) => guess.result === GuessResult.DUPLICATE).length,
      failedGuessCount: priorGuesses.filter(
        (guess) => guess.result === GuessResult.FAILURE || guess.result === GuessResult.OFF_BY_ONE,
      ).length,
      malformedCount: 0,
      consecutiveModelErrors: 0,
      rateLimitWaitMs: null,
      lockedInGroups: [],
      lastFailedGuess: null,
      priorGuesses,
    };

    const maxDuplicates = llmMaxDuplicateGuesses();
    const maxFailedGuesses = llmMaxFailedGuesses();
    const maxMalformed = llmMaxMalformedResponses();
    const maxModelErrors = llmMaxModelErrors();
    const temperature = llmTemperature();

    // Conversation history for the AI Assist prompt flow.
    const messages: ChatMessage[] = [];

    const pendingGuesses: Partial<Guess>[] = [];
    const pendingProposals: Partial<LlmProposal>[] = [];
    const pendingPrompts: Partial<SolvePrompt>[] = [];
    let globalPromptNumber = await this.store.lastPromptNumber(run.id);

    while (true) {
      const N = run.availableWords.length / GROUP_SIZE;

      // Build the prompt for this step.
      const prompt = state.lastFailedGuess
        ? buildRetryPrompt(run.availableWords, state.lockedInGroups, state.lastFailedGuess, N)
        : buildInitialPrompt(run.availableWords, N);

      // Append the user message to conversation history.
      messages.push({ role: "user", content: prompt });

      const outcome = await this.orchestratorService.solveAssist(
        messages,
        model,
        provider,
        contextWindow,
      );

      // One promptNumber per loop iteration.
      globalPromptNumber++;
      const promptType = state.lastFailedGuess
        ? SolvePromptType.RETRY
        : SolvePromptType.INITIAL_SOLVE;
      // The orchestrator makes exactly one real OpenAI call per solveAssist
      // invocation (no client-side retry — see orchestrator.service.ts), so
      // every step's row is always its own first and only attempt.
      const attemptNumber = 1;

      if (outcome.ok) {
        const data = outcome.data;
        state.consecutiveModelErrors = 0;

        // Set run-level model metadata from the first successful call.
        if (run.modelName === null) {
          run.modelName = data.model;
        }
        // Correct the run's contextWindow to the actual value the call
        // used — may differ from the pre-call guess (see loadOrCreateRun)
        // since Ollama's is always capped at the orchestrator's own
        // MODEL_CONTEXT_WINDOW (see OrchestratorService.solveAssist).
        if (data.contextWindow !== undefined) {
          run.contextWindow = data.contextWindow;
        }

        // Append the assistant response to conversation history.
        messages.push({ role: "assistant", content: data.response });

        // Create a SolvePrompt row for this LLM call.
        const currentPrompt: Partial<SolvePrompt> = {
          strategyRunId: run.id,
          promptNumber: globalPromptNumber,
          attemptNumber,
          promptType,
          status: SolvePromptStatus.PARSED,
          rawResponseText: data.response,
          issueTags: [],
          temperature,
          promptTokens: data.usage?.promptTokens ?? null,
          completionTokens: data.usage?.completionTokens ?? null,
          totalTokens: data.usage?.totalTokens ?? null,
          latencyMs: data.latencyMs,
          requestBody: data.requestBody ?? null,
          responseId: data.responseId ?? null,
          responseHeaders: data.responseHeaders ?? null,
          responseBody: this.toJsonbResponseBody(data.responseBody),
        };
        pendingPrompts.push(currentPrompt);

        const groups = data.groups;
        if (groups.length === 0) {
          // currentPrompt is the same object already queued in pendingPrompts,
          // so mutating it here still reflects at flush time.
          currentPrompt.status = SolvePromptStatus.MALFORMED_NO_ANSWER_BLOCK;
          state.malformedCount++;
          if (state.malformedCount >= maxMalformed) {
            run.status = StrategyRunStatus.MALFORMED_RESPONSE;
            run.finishedAt = new Date();
          }
        } else {
          const { proposalWords, categoryMap, issueTags } = parseGroupsSection(
            data.response ?? "",
            groups,
          );
          // currentPrompt is the same object already queued in
          // pendingPrompts, so mutating it here still reflects at flush time.
          currentPrompt.issueTags = issueTags;

          const proposalEntries = this.buildProposalEntries(
            proposalWords,
            categoryMap,
            run,
            currentPrompt,
          );
          pendingProposals.push(...proposalEntries);

          this.evaluateProposals(
            proposalEntries,
            run,
            puzzle,
            puzzleId,
            state,
            pendingGuesses,
            maxDuplicates,
            maxFailedGuesses,
          );
        }
      } else {
        // The prompt was already pushed as a user turn before this call; the
        // call failed with no assistant reply, so drop it rather than let
        // the next retry stack a second consecutive user turn on top of it.
        messages.pop();

        // The step's failure gets its own row too — previously this
        // outcome left zero trace in the database.
        pendingPrompts.push(
          this.buildCallErrorPromptRow(run.id, globalPromptNumber, promptType, {
            attemptNumber,
            requestBody: outcome.error.requestBody,
            responseId: outcome.error.responseId,
            responseHeaders: outcome.error.responseHeaders,
            responseBody: outcome.error.responseBody,
            statusCode: outcome.error.statusCode,
            errorName: outcome.error.errorName,
            errorMessage: outcome.error.error,
            isRetryable: outcome.error.isRetryable,
          }),
        );

        this.classifyFailedCall(
          outcome.error.code,
          run,
          state,
          maxModelErrors,
          maxDuplicates,
          maxMalformed,
          outcome.error.retryAfterSeconds,
        );

        if (
          outcome.error.code === "rate_limited_daily" &&
          strategyName === LLM_GOOGLE &&
          model
        ) {
          await this.rpdHold.hold(strategyName, model);
        }
      }

      // Flush every iteration.
      await this.store.flushBatch(run, pendingGuesses, pendingProposals, pendingPrompts);

      // A rate-limited hit waits exactly as long as Google says to, taking
      // priority over the model-error backoff below — the two never apply
      // to the same failed call (classifyFailedCall sets at most one).
      if (run.status === StrategyRunStatus.RUNNING && state.rateLimitWaitMs !== null) {
        await this.delay(state.rateLimitWaitMs);
        state.rateLimitWaitMs = null;
      } else if (run.status === StrategyRunStatus.RUNNING && state.consecutiveModelErrors > 0) {
        await this.delay(this.modelErrorBackoff(state.consecutiveModelErrors));
      }

      if (run.status !== StrategyRunStatus.RUNNING) {
        break;
      }
    }

    return { status: run.status, guessCount: state.guessCount };
  }

  /**
   * Builds a SolvePrompt row for a step's OpenAI call that never produced
   * usable model text. Carries whatever raw request/response detail the
   * orchestrator captured, so a failed call still leaves enough to
   * diagnose it (previously these left no row at all — see
   * orchestrator.service.ts and solver.ts).
   */
  private buildCallErrorPromptRow(
    strategyRunId: number,
    promptNumber: number,
    promptType: SolvePromptType,
    attempt: {
      attemptNumber: number;
      requestBody?: unknown;
      responseId?: string;
      responseHeaders?: Record<string, string>;
      responseBody?: unknown;
      statusCode?: number;
      errorName?: string;
      errorMessage?: string;
      isRetryable?: boolean;
    },
  ): Partial<SolvePrompt> {
    return {
      strategyRunId,
      promptNumber,
      attemptNumber: attempt.attemptNumber,
      promptType,
      status: SolvePromptStatus.CALL_ERROR,
      requestBody: attempt.requestBody ?? null,
      responseId: attempt.responseId ?? null,
      responseHeaders: attempt.responseHeaders ?? null,
      responseBody: this.toJsonbResponseBody(attempt.responseBody),
      statusCode: attempt.statusCode ?? null,
      errorName: attempt.errorName ?? null,
      errorMessage: attempt.errorMessage ?? null,
      isRetryable: attempt.isRetryable ?? null,
    };
  }

  /**
   * `responseBody` is a `jsonb` column, which requires a valid JSON value.
   * On success it's always an object (AI SDK gives back the parsed OpenAI
   * response). On failure it's `APICallError.responseBody` — a raw string
   * with no guarantee of being valid JSON (could be a gateway HTML error
   * page, plain text, etc). Parse it when possible so the column stays
   * queryable, since real OpenAI error bodies are JSON; otherwise store the
   * raw string itself, which is still valid jsonb — this never fails to
   * write and never silently drops the original text.
   */
  private toJsonbResponseBody(value: unknown): unknown {
    if (typeof value !== "string") return value ?? null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  /**
   * Builds one LlmProposal draft per valid (exactly GROUP_SIZE words)
   * parsed group, tagging each with its extracted category (or a
   * placeholder when the model's response never labeled that group
   * number). Every proposal starts 'not selected' — evaluateProposals below
   * flips whichever ones are actually submitted as guesses to 'used'.
   */
  private buildProposalEntries(
    proposalWords: string[][],
    categoryMap: Map<number, string>,
    run: StrategyRun,
    currentPrompt: Partial<SolvePrompt>,
  ): Partial<LlmProposal>[] {
    const proposalEntries: Partial<LlmProposal>[] = [];

    for (let i = 0; i < proposalWords.length; i++) {
      const words = proposalWords[i];
      if (!words || words.length !== GROUP_SIZE) continue;

      const extractedCategory = categoryMap.get(i + 1);
      const category = extractedCategory ?? `Category unavailable for group ${i + 1}`;

      proposalEntries.push({
        strategyRun: { id: run.id } as StrategyRun,
        solvePrompt: currentPrompt as SolvePrompt,
        words,
        category,
        status: LlmProposalStatus.NOT_SELECTED,
        guess: undefined,
      });
    }

    return proposalEntries;
  }

  /**
   * Submits proposals as guesses in order, stopping at the first failure
   * (or once the puzzle is solved) — evaluation halts on the first miss
   * rather than trying every proposal in the batch. Mutates `run`
   * (status/finishedAt/availableWords/currentCombination) and `state`
   * (counts, lockedInGroups, lastFailedGuess, priorGuesses) in place, and
   * appends to `pendingGuesses`, rather than returning new values — `state`
   * is the run loop's single source of truth for the rest of the call.
   */
  private evaluateProposals(
    proposalEntries: Partial<LlmProposal>[],
    run: StrategyRun,
    puzzle: Puzzle,
    puzzleId: number,
    state: LlmRunLoopState,
    pendingGuesses: Partial<Guess>[],
    maxDuplicates: number,
    maxFailedGuesses: number,
  ): void {
    // The full original puzzle word set, used below to tell "already solved
    // by an earlier guess" apart from "genuine hallucination." Derived from
    // the puzzle's own DB-backed answer groups (already eagerly loaded by
    // StrategyRunStore.loadOrCreateRun's `relations: { answerGroups: {
    // members: true } }`) rather than
    // `run.availableWords ∪ flatten(state.lockedInGroups)`, because
    // state.lockedInGroups is unconditionally reset to [] at the top of
    // every call to runLlmStrategy — including a resumed run, whose
    // priorGuesses is rebuilt from stored Guess rows but whose
    // lockedInGroups is not — so deriving from in-memory loop state would
    // falsely tag an already-solved word as wordNotOnList after a worker
    // restart. This is loop-invariant (the puzzle's answer groups never
    // change during a run), so it's computed once here rather than fresh
    // per proposal.
    const originalPuzzleWords = new Set(
      puzzle.answerGroups.flatMap((group) => group.members.map((member) => member.word)),
    );

    for (const currentProposal of proposalEntries) {
      const guessWords = currentProposal.words!;

      // A word missing from run.availableWords is either already solved by
      // an earlier guess in this loop (expected, boring — every word in
      // state.lockedInGroups is still a real puzzle word) or was never part
      // of the puzzle at all (a genuine model hallucination). Both skip the
      // proposal the same way today; only the second is worth flagging.
      const isWordMissingFromAvailable = guessWords.some((w) => !run.availableWords.includes(w));
      if (isWordMissingFromAvailable) {
        const hasHallucinatedWord = guessWords.some((w) => !originalPuzzleWords.has(w));
        if (hasHallucinatedWord) {
          const issueTags = currentProposal.solvePrompt!.issueTags;
          if (!issueTags.includes(SolvePromptIssueTag.WORD_NOT_ON_LIST)) {
            issueTags.push(SolvePromptIssueTag.WORD_NOT_ON_LIST);
          }
        }
        continue;
      }

      state.guessCount++;
      const isDuplicate = state.priorGuesses.some(
        (g) => g.words.length === guessWords.length && g.words.every((w) => guessWords.includes(w)),
      );
      const evaluation: { result: GuessResult } = isDuplicate
        ? { result: GuessResult.DUPLICATE }
        : GameService.evaluateGuessOnPuzzle(puzzle, guessWords);

      const newGuess: Partial<Guess> = {
        puzzle: { id: puzzleId } as Puzzle,
        strategyRun: { id: run.id } as StrategyRun,
        words: guessWords,
        result: evaluation.result,
        sequenceNumber: state.guessCount,
        source: GuessSource.STRATEGY,
      };

      pendingGuesses.push(newGuess);

      // Mark the proposal as 'used' and bind it specifically to this new
      // sequential guess.
      currentProposal.status = LlmProposalStatus.USED;
      currentProposal.guess = newGuess as Guess;

      state.priorGuesses.push({ words: guessWords, result: evaluation.result });

      if (evaluation.result === GuessResult.SUCCESS) {
        run.availableWords = run.availableWords.filter((w) => !guessWords.includes(w));
        state.lockedInGroups.push(guessWords);
        state.lastFailedGuess = null;
        run.currentCombination = firstCombination(GROUP_SIZE);

        if (run.availableWords.length === 0) {
          run.status = StrategyRunStatus.COMPLETED;
          run.finishedAt = new Date();
          break;
        }
      } else {
        state.failedGuessCount++;
        const resultStr = evaluation.result === GuessResult.OFF_BY_ONE ? "one away" : "incorrect";
        state.lastFailedGuess = { items: guessWords, result: resultStr };

        if (evaluation.result === GuessResult.DUPLICATE) {
          state.duplicateCount++;
          if (state.duplicateCount >= maxDuplicates) {
            run.status = StrategyRunStatus.DUPLICATE;
            run.finishedAt = new Date();
          }
        }
        if (state.failedGuessCount >= maxFailedGuesses) {
          run.status = StrategyRunStatus.FAILED;
          run.finishedAt = new Date();
        }

        // Stop evaluating subsequent proposals from this batch if a guess fails.
        break;
      }
    }
  }

  /**
   * Classifies a failed orchestrator call (no assistant reply at all).
   * "rate_limited" (Google per-minute hit only) is never a failure — it
   * touches no counter and never changes run.status, only sets
   * state.rateLimitWaitMs so the run loop waits the server-specified
   * duration and retries the identical request. Every other code bumps
   * that failure kind's own counter, ending the run once its limit is hit
   * — or otherwise leaves run.status as RUNNING so the loop retries next
   * iteration.
   */
  private classifyFailedCall(
    code: SolveErrorCode,
    run: StrategyRun,
    state: LlmRunLoopState,
    maxModelErrors: number,
    maxDuplicates: number,
    maxMalformed: number,
    retryAfterSeconds?: number,
  ): void {
    if (code === "rate_limited_daily") {
      // A per-day quota hit. Park the run — no counter touched, so it never
      // rolls into ERROR — and let the run loop's status check break out.
      // The hold row itself is written by the caller (it has `model` and can
      // await), see runLlmStrategy's failed-call block.
      run.status = StrategyRunStatus.RATE_LIMITED_DAILY;
      run.finishedAt = new Date();
    } else if (code === "rate_limited") {
      state.rateLimitWaitMs = (retryAfterSeconds ?? llmGoogleRateLimitFallbackSeconds()) * 1000;
    } else if (code === "model_error") {
      state.consecutiveModelErrors++;
      if (state.consecutiveModelErrors >= maxModelErrors) {
        run.status = StrategyRunStatus.ERROR;
        run.finishedAt = new Date();
      }
    } else if (code === "duplicate_group") {
      state.duplicateCount++;
      if (state.duplicateCount >= maxDuplicates) {
        run.status = StrategyRunStatus.DUPLICATE;
        run.finishedAt = new Date();
      }
    } else {
      state.malformedCount++;
      if (state.malformedCount >= maxMalformed) {
        run.status = StrategyRunStatus.MALFORMED_RESPONSE;
        run.finishedAt = new Date();
      }
    }
  }

  private modelErrorBackoff(consecutiveErrors: number): number {
    return Math.min(
      MODEL_ERROR_RETRY_MAX_DELAY_MS,
      MODEL_ERROR_RETRY_BASE_DELAY_MS * 2 ** (consecutiveErrors - 1),
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async loadLlmGuessesForRun(strategyRunId: number): Promise<Guess[]> {
    return this.guessRepo.find({
      where: { strategyRunId },
      order: { sequenceNumber: "ASC" },
      select: { words: true, result: true },
    });
  }
}
