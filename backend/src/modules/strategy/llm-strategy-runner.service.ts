import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { GameService } from "../game/game.service";
import {
  llmMaxDuplicateGuesses,
  llmMaxFailedGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmTemperature,
} from "../../strategies";
import { Guess, GuessResult, GuessSource } from "./entities/guess.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
import { SolvePrompt, SolvePromptType, SolvePromptStatus } from "./entities/solve-prompt.entity";
import { StrategyRun, StrategyRunStatus, TERMINAL_STATUSES } from "./entities/strategy-run.entity";
import { OrchestratorService, type ChatMessage } from "./orchestrator.service";
import { StrategyRunStore } from "./strategy-run-store.service";
import { firstCombination } from "./combinatorics";
import { delay, async } from "rxjs";

const GROUP_SIZE = 4;

const MODEL_ERROR_RETRY_BASE_DELAY_MS = 1000;
const MODEL_ERROR_RETRY_MAX_DELAY_MS = 300000;

function buildInitialPrompt(items: string[], N: number): string {
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
    `Format Requirements:`,
    `You MUST output your response in EXACTLY two sections (GROUPS and ANSWER), following this schema:`,
    ``,
    `### GROUPS`,
    ...Array.from(
      { length: N },
      (_, i) =>
        `Group ${i + 1}\nReasoning: <1-2 sentences explaining the category connection>\nWords: <ITEM1>, <ITEM2>, <ITEM3>, <ITEM4>\n`,
    ),
    `### ANSWER`,
    ...Array.from({ length: N }, () => `<ITEM1>, <ITEM2>, <ITEM3>, <ITEM4>`),
  ].join("\n");
}

function buildRetryPrompt(
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
    `Format Requirements:`,
    `You MUST output your response in EXACTLY two sections (GROUPS and ANSWER), following this schema:`,
    ``,
    `### GROUPS`,
    ...Array.from(
      { length: N },
      (_, i) =>
        `Group ${i + 1}\nReasoning: <1-2 sentences explaining the category connection>\nWords: <ITEM1>, <ITEM2>, <ITEM3>, <ITEM4>\n`,
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
  ) {}

  async runLlmStrategy(puzzleId: number, strategyName: string, trialNumber = 0) {
    const { run, puzzle } = await this.store.loadOrCreateRun(puzzleId, strategyName, trialNumber);

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
    let guessCount = priorGuesses.length;
    let duplicateCount = priorGuesses.filter(
      (guess) => guess.result === GuessResult.DUPLICATE,
    ).length;
    let failedGuessCount = priorGuesses.filter(
      (guess) => guess.result === GuessResult.FAILURE || guess.result === GuessResult.OFF_BY_ONE,
    ).length;
    let malformedCount = 0;
    const maxDuplicates = llmMaxDuplicateGuesses();
    const maxFailedGuesses = llmMaxFailedGuesses();
    const maxMalformed = llmMaxMalformedResponses();
    const maxModelErrors = llmMaxModelErrors();
    const temperature = llmTemperature();
    let consecutiveModelErrors = 0;

    // Conversation history for the AI Assist prompt flow.
    const messages: ChatMessage[] = [];
    // Groups confirmed correct — used to build RETRY prompts.
    const lockedInGroups: string[][] = [];
    // The last failed guess — used to build RETRY prompts.
    let lastFailedGuess: { items: string[]; result: string } | null = null;

    const pendingGuesses: Partial<Guess>[] = [];
    const pendingProposals: Partial<LlmProposal>[] = [];
    const pendingPrompts: Partial<SolvePrompt>[] = [];
    let globalPromptNumber = await this.store.countPrompts(run.id);

    while (true) {
      const N = run.availableWords.length / GROUP_SIZE;

      // Build the prompt for this step.
      let prompt: string;
      if (lastFailedGuess) {
        prompt = buildRetryPrompt(run.availableWords, lockedInGroups, lastFailedGuess, N);
      } else {
        prompt = buildInitialPrompt(run.availableWords, N);
      }

      // Append the user message to conversation history.
      messages.push({ role: "user", content: prompt });

      const outcome = await this.orchestratorService.solveAssist(messages);

      if (outcome.ok) {
        const data = outcome.data;
        consecutiveModelErrors = 0;

        // Set run-level model metadata from the first successful call.
        if (run.modelName === null) {
          run.modelName = data.model;
        }

        // Append the assistant response to conversation history.
        messages.push({ role: "assistant", content: data.response });

        // Create a SolvePrompt row for this LLM call.
        globalPromptNumber++;
        const promptType = lastFailedGuess ? SolvePromptType.RETRY : SolvePromptType.INITIAL_SOLVE;
        const currentPrompt: Partial<SolvePrompt> = {
          strategyRunId: run.id,
          promptNumber: globalPromptNumber,
          promptType,
          status: SolvePromptStatus.PARSED,
          rawResponseText: data.response,
          temperature,
        };
        pendingPrompts.push(currentPrompt);

        const groups = data.groups;
        if (groups.length === 0) {
          malformedCount++;
          if (malformedCount >= maxMalformed) {
            run.status = StrategyRunStatus.MALFORMED_RESPONSE;
            run.finishedAt = new Date();
          }
        } else {
          const responseText = data.response ?? "";
          const explanationMap = new Map<number, string>();
          const parsedGroupWords: string[][] = [];

          // Parse structured "Group N" blocks: Reasoning + Words
          const groupBlockRegex =
            /Group\s+(\d+)[\s\S]*?Reasoning:\s*([^\n]+)[\s\S]*?Words:\s*([^\n]+)/gi;
          let match: RegExpExecArray | null;

          while ((match = groupBlockRegex.exec(responseText)) !== null) {
            const groupNum = parseInt(match[1], 10);
            const reasoningText = match[2].trim();
            const wordsLine = match[3]
              .split(",")
              .map((w) => w.replace(/[`*]/g, "").trim())
              .filter(Boolean);

            explanationMap.set(groupNum, reasoningText);
            if (wordsLine.length === GROUP_SIZE) {
              parsedGroupWords[groupNum - 1] = wordsLine;
            }
          }

          // Use parsed words from the GROUPS block if available; fall back to incoming `groups` array
          const sourceGroups = parsedGroupWords.length > 0 ? parsedGroupWords : groups;
          const proposalWords = sourceGroups.map((group) => group.map((item) => item.trim()));

          const proposalEntries: Partial<LlmProposal>[] = [];
          for (let i = 0; i < proposalWords.length; i++) {
            const words = proposalWords[i];
            if (!words || words.length !== GROUP_SIZE) continue;

            const extractedReasoning = explanationMap.get(i + 1);
            const reasoning = extractedReasoning ?? `Group ${i + 1} from AI Assist response`;

            const proposalObj: Partial<LlmProposal> = {
              strategyRun: { id: run.id } as StrategyRun,
              solvePrompt: currentPrompt as SolvePrompt,
              words,
              reasoning,
              status: LlmProposalStatus.NOT_SELECTED,
              guess: undefined,
            };

            pendingProposals.push(proposalObj);
            proposalEntries.push(proposalObj);
          }

          // Evaluate parsed proposals sequentially as long as submitted guesses succeed.
          for (let i = 0; i < proposalEntries.length; i++) {
            const currentProposal = proposalEntries[i];
            const guessWords = currentProposal.words!;

            // Skip proposals containing words that were already solved by an earlier guess in this loop.
            const isWordAlreadySolved = guessWords.some((w) => !run.availableWords.includes(w));
            if (isWordAlreadySolved) {
              continue;
            }

            guessCount++;
            const evaluation = GameService.evaluateGuessOnPuzzle(puzzle, guessWords);

            const newGuess: Partial<Guess> = {
              puzzle: { id: puzzleId } as Puzzle,
              strategyRun: { id: run.id } as StrategyRun,
              words: guessWords,
              result: evaluation.result,
              sequenceNumber: guessCount,
              source: GuessSource.STRATEGY,
            };

            pendingGuesses.push(newGuess);

            // Mark the proposal as 'used' and bind it specifically to this new sequential guess.
            currentProposal.status = LlmProposalStatus.USED;
            currentProposal.guess = newGuess as Guess;

            priorGuesses.push({ words: guessWords, result: evaluation.result });

            if (evaluation.result === GuessResult.SUCCESS) {
              run.availableWords = run.availableWords.filter((w) => !guessWords.includes(w));
              lockedInGroups.push(guessWords);
              lastFailedGuess = null;
              run.currentCombination = firstCombination(GROUP_SIZE);

              if (run.availableWords.length === 0) {
                run.status = StrategyRunStatus.COMPLETED;
                run.finishedAt = new Date();
                break;
              }
            } else {
              failedGuessCount++;
              const resultStr =
                evaluation.result === GuessResult.OFF_BY_ONE ? "one away" : "incorrect";
              lastFailedGuess = { items: guessWords, result: resultStr };

              if (evaluation.result === GuessResult.DUPLICATE) {
                duplicateCount++;
                if (duplicateCount >= maxDuplicates) {
                  run.status = StrategyRunStatus.DUPLICATE;
                  run.finishedAt = new Date();
                }
              }
              if (failedGuessCount >= maxFailedGuesses) {
                run.status = StrategyRunStatus.FAILED;
                run.finishedAt = new Date();
              }

              // Stop evaluating subsequent proposals from this batch if a guess fails.
              break;
            }
          }
        }
      } else if (!outcome.ok) {
        const { code } = outcome.error;

        if (code === "model_error") {
          consecutiveModelErrors++;
          if (consecutiveModelErrors >= maxModelErrors) {
            run.status = StrategyRunStatus.ERROR;
            run.finishedAt = new Date();
          }
        } else if (code === "duplicate_group") {
          duplicateCount++;
          if (duplicateCount >= maxDuplicates) {
            run.status = StrategyRunStatus.DUPLICATE;
            run.finishedAt = new Date();
          }
        } else {
          malformedCount++;
          if (malformedCount >= maxMalformed) {
            run.status = StrategyRunStatus.MALFORMED_RESPONSE;
            run.finishedAt = new Date();
          }
        }
      }

      // Flush every iteration.
      await this.store.flushBatch(run, pendingGuesses, pendingProposals, pendingPrompts);

      // After a transient model failure, pause before re-prompting.
      if (run.status === StrategyRunStatus.RUNNING && consecutiveModelErrors > 0) {
        await this.delay(this.modelErrorBackoff(consecutiveModelErrors));
      }

      if (run.status !== StrategyRunStatus.RUNNING) {
        break;
      }
    }

    return { status: run.status, guessCount };
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
