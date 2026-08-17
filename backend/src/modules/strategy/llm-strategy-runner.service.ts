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

const GROUP_SIZE = 4;

const MODEL_ERROR_RETRY_BASE_DELAY_MS = 1000;
const MODEL_ERROR_RETRY_MAX_DELAY_MS = 300000;

function buildInitialPrompt(items: string[], N: number): string {
  return [
    `You are playing NYT Connections. The items below form ${N} groups of four, where each group shares something in common. Propose your best guess for all ${N} groups.`,
    "",
    `Items: ${items.join(", ")}`,
    "",
    `For each of your ${N} proposed groups, briefly explain (1-2 sentences) why you believe those four items belong together. Then output a line containing only "ANSWER:", followed by exactly ${N} lines, each with four comma-separated items — one line per group. Output nothing after those lines.`,
    "",
    "Use each item exactly once. Only use items from the list above — do not introduce new words.",
  ].join("\n");
}

function buildRetryPrompt(
  remainingItems: string[],
  lockedInGroups: string[][],
  lastFailedGuess: { items: string[]; result: string },
  N: number,
): string {
  const parts = [
    `Feedback on your last guess: the group ${lastFailedGuess.items.join(", ")} was ${lastFailedGuess.result}.`,
    "",
    '- If the result is "incorrect": these four items are not all part of the same group.',
    '- If the result is "one away": three of these four items belong together in a group, but one of them does not.',
  ];

  if (lockedInGroups.length > 0) {
    parts.push(
      "",
      `The following group(s) are already confirmed correct and should not be changed: ${lockedInGroups
        .map((group) => `[${group.join(", ")}]`)
        .join(", ")}.`,
    );
  }

  parts.push(
    "",
    `The remaining items still to be grouped are: ${remainingItems.join(", ")}, forming ${N} group(s) of four.`,
    "",
    `Considering this feedback, propose your best guess for all ${N} remaining groups. As before, briefly explain your reasoning for each, then output "ANSWER:" followed by ${N} lines of four comma-separated items.`,
    "",
    "Use each item exactly once. Only use items from the list above — do not introduce new words.",
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
        prompt = buildRetryPrompt(
          run.availableWords,
          lockedInGroups,
          lastFailedGuess,
          N,
        );
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
        const promptType = lastFailedGuess
          ? SolvePromptType.RETRY
          : SolvePromptType.INITIAL_SOLVE;
        pendingPrompts.push({
          strategyRunId: run.id,
          promptNumber: globalPromptNumber,
          promptType,
          status: SolvePromptStatus.PARSED,
          rawResponseText: data.response,
          temperature,
        });

        const groups = data.groups;
        if (groups.length === 0) {
          malformedCount++;
          if (malformedCount >= maxMalformed) {
            run.status = StrategyRunStatus.MALFORMED_RESPONSE;
            run.finishedAt = new Date();
          }
        } else {
          // Create an LlmProposal for each parsed group.
          const proposalWords = groups.map((group) =>
            group.map((item) => item.trim()),
          );

          for (let i = 0; i < proposalWords.length; i++) {
            const words = proposalWords[i];
            if (words.length !== GROUP_SIZE) continue;

            pendingProposals.push({
              strategyRun: { id: run.id } as StrategyRun,
              solvePromptId: undefined, // resolved by flushBatch via promptNumber
              words,
              reasoning: `Group ${i + 1} from AI Assist response`,
              status: LlmProposalStatus.NOT_SELECTED,
            });
          }

          // Submit the first well-formed group as the guess.
          const guessWords = proposalWords[0];
          if (guessWords && guessWords.length === GROUP_SIZE) {
            guessCount++;
            const evaluation = GameService.evaluateGuessOnPuzzle(puzzle, guessWords);

            pendingGuesses.push({
              puzzle: { id: puzzleId } as Puzzle,
              strategyRun: { id: run.id } as StrategyRun,
              words: guessWords,
              result: evaluation.result,
              sequenceNumber: guessCount,
              source: GuessSource.STRATEGY,
            });

            // Mark the first proposal as 'used'.
            if (pendingProposals.length > 0) {
              pendingProposals[pendingProposals.length - proposalWords.length].status =
                LlmProposalStatus.USED;
            }

            priorGuesses.push({ words: guessWords, result: evaluation.result });

            if (evaluation.result === GuessResult.SUCCESS) {
              run.availableWords = run.availableWords.filter(
                (w) => !guessWords.includes(w),
              );
              lockedInGroups.push(guessWords);
              lastFailedGuess = null;
              run.currentCombination = firstCombination(GROUP_SIZE);

              if (run.availableWords.length === 0) {
                run.status = StrategyRunStatus.COMPLETED;
                run.finishedAt = new Date();
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
