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
import { firstCombination } from "./combinatorics";

const GROUP_SIZE = 4;

const MODEL_ERROR_RETRY_BASE_DELAY_MS = 1000;
const MODEL_ERROR_RETRY_MAX_DELAY_MS = 300000;

// Some models (Mistral especially) don't put their reasoning in the
// scratchpad the prompt asks for — they append it straight onto the
// "Words:" line instead, e.g. "LOOK, TOUCH, SIGHT, SMELL (these are all
// senses)". Left in, that either glues onto the 4th word (breaking every
// downstream comparison against the puzzle's real words) or, when the
// aside itself contains commas, inflates the line past 4 tokens and gets
// the whole group discarded. Stripping it before splitting on commas fixes
// both cases at once, since either way what's left is the 4 bare words.
const WORDS_PARENTHETICAL_RE = /\([^)]*\)/g;

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
          const { proposalWords, categoryMap, issueTags } = this.parseGroupsSection(
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

        this.classifyFailedCall(outcome.error.code, run, state, maxModelErrors, maxDuplicates, maxMalformed);
      }

      // Flush every iteration.
      await this.store.flushBatch(run, pendingGuesses, pendingProposals, pendingPrompts);

      // After a transient model failure, pause before re-prompting.
      if (run.status === StrategyRunStatus.RUNNING && state.consecutiveModelErrors > 0) {
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
   * Parses the "Category:"/"Words:" lines out of a response's ### GROUPS
   * section (falling back to the whole response text if that heading is
   * missing), returning cleaned per-group word lists plus each group
   * number's extracted category. `fallbackGroups` (the already-parsed
   * ### ANSWER lines the orchestrator returns) is used verbatim when this
   * structured parse finds nothing.
   */
  private parseGroupsSection(
    responseText: string,
    fallbackGroups: string[][],
  ): { proposalWords: string[][]; categoryMap: Map<number, string>; issueTags: string[] } {
    const categoryMap = new Map<number, string>();
    const parsedGroupWords: string[][] = [];
    const tags = new Set<string>();
    const wrongCountGroupNumbers = new Set<number>();
    // Highest "Group N" heading number the response itself mentioned — the
    // catch-all below checks against this, never against the puzzle's
    // total remaining group count. The model normally addresses just one
    // group per call (the common case, not an error), so a response that
    // simply doesn't mention a group at all must never be flagged.
    let maxGroupNum = 0;

    // Scope parsing to the ### GROUPS section so scratchpad content
    // (which may itself mention "Group" or contain stray colons) can't
    // produce false matches.
    const groupsSectionMatch = responseText.match(/### GROUPS([\s\S]*?)### ANSWER/i);
    const groupsSectionText = groupsSectionMatch ? groupsSectionMatch[1] : responseText;

    // Parse structured "Group N" blocks: Category + Words. Split into
    // per-group chunks first (on each "Group N" heading) so a missing
    // field in one group can't bleed into the next group's match.
    const groupChunks = groupsSectionText.split(/(?=Group\s+\d+)/i);

    for (const chunk of groupChunks) {
      const headingMatch = chunk.match(/Group\s+(\d+)/i);
      if (!headingMatch) continue;

      const groupNum = parseInt(headingMatch[1], 10);
      maxGroupNum = Math.max(maxGroupNum, groupNum);
      const categoryMatch = chunk.match(/Category:\s*([^\n]+)/i);
      const wordsMatch = chunk.match(/Words:\s*([^\n]+)/i);

      if (categoryMatch) {
        categoryMap.set(groupNum, categoryMatch[1].trim());
      }

      if (wordsMatch) {
        const rawWordsLine = wordsMatch[1];
        // .replace() with a global regex, not .test() — WORDS_PARENTHETICAL_RE
        // is a shared module-level instance, and a global regex's .test()
        // mutates its own lastIndex across calls, which would silently
        // start missing matches on later prompts. Comparing before/after
        // avoids that stateful pitfall entirely.
        const strippedWordsLine = rawWordsLine.replace(WORDS_PARENTHETICAL_RE, "");
        if (strippedWordsLine !== rawWordsLine) {
          tags.add(SolvePromptIssueTag.PARENTHETICAL_STRIPPED);
        }

        const wordsLine = strippedWordsLine
          .split(",")
          .map((w) => w.replace(/[`*]/g, "").trim())
          .filter(Boolean);

        if (wordsLine.length === GROUP_SIZE) {
          parsedGroupWords[groupNum - 1] = wordsLine;
        } else {
          // A Words: line was found and split, but produced the wrong word
          // count — the group is dropped (same as before), now flagged so
          // it's queryable rather than silently vanishing.
          tags.add(SolvePromptIssueTag.GROUP_COUNT_OFF);
          wrongCountGroupNumbers.add(groupNum);
        }
      }
    }

    // Use parsed words from the GROUPS block if available; fall back to the
    // already-parsed ### ANSWER lines.
    const usedStructuredParse = parsedGroupWords.length > 0;
    const sourceGroups = usedStructuredParse ? parsedGroupWords : fallbackGroups;
    const proposalWords = sourceGroups.map((group) => group.map((item) => item.trim()));

    // Catch-all: within the range of group numbers this response's own
    // headings actually mentioned (1..maxGroupNum), a group number that
    // never landed in parsedGroupWords and isn't already explained by a
    // wrong word count is a failure shape this parser doesn't have a name
    // for yet — e.g. a heading with no Words: line at all, or a skipped
    // number between two real headings. No gate on usedStructuredParse
    // needed here: maxGroupNum only increments when a "Group N" heading
    // actually matched, so when a response has zero such headings anywhere
    // (the true "totally different format" fallback case), maxGroupNum
    // stays 0 and this loop's own bound means the body never runs — the
    // loop's range is already the correct gate on its own.
    for (let groupNum = 1; groupNum <= maxGroupNum; groupNum++) {
      if (!parsedGroupWords[groupNum - 1] && !wrongCountGroupNumbers.has(groupNum)) {
        tags.add(SolvePromptIssueTag.UNCLASSIFIED);
      }
    }

    return { proposalWords, categoryMap, issueTags: Array.from(tags) };
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
   * Classifies a failed orchestrator call (no assistant reply at all) into
   * the same three outcomes the code this was extracted from handled: bump
   * that failure kind's own counter, ending the run once its limit is hit
   * — or otherwise leave `run.status` as RUNNING so the loop retries next
   * iteration.
   */
  private classifyFailedCall(
    code: SolveErrorCode,
    run: StrategyRun,
    state: LlmRunLoopState,
    maxModelErrors: number,
    maxDuplicates: number,
    maxMalformed: number,
  ): void {
    if (code === "model_error") {
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
