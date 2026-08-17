import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { GameService } from "../game/game.service";
import {
  LLM_OPENAI,
  MAX_LLM_NUM_RESPONSES,
  llmMaxDuplicateGuesses,
  llmMaxFailedGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmMaxPrompts,
  llmNumResponses,
  llmTemperature,
} from "../../strategies";
import { Guess, GuessResult, GuessSource } from "./entities/guess.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
import { StrategyRun, StrategyRunStatus, TERMINAL_STATUSES } from "./entities/strategy-run.entity";
import { OrchestratorService, type ModelProvider } from "./orchestrator.service";
import { StrategyRunStore } from "./strategy-run-store.service";
import { firstCombination } from "./combinatorics";

const GROUP_SIZE = 4;

// Backoff between retries of a transient model failure (e.g. the Ollama model
// still loading after a cold start). Exponential from 1s, capped at 5min.
const MODEL_ERROR_RETRY_BASE_DELAY_MS = 1000;
const MODEL_ERROR_RETRY_MAX_DELAY_MS = 300000;

/**
 * Iterative LLM strategy runner: calls the orchestrator's /solve with the
 * remaining words plus the full guess history. The strategy name (llm-openai or
 * llm-ollama) selects which LLM backend the orchestrator consults for every
 * solve step. Each step starts by asking the model for a single answer; when
 * every candidate repeats a prior guess, the orchestrator re-prompts asking
 * for one more distinct candidate (at a fixed sampling temperature) until a
 * fresh candidate appears or its prompt budget runs out. The candidate count
 * restarts from its base on each step; the temperature is the same for every
 * call of the run.
 *
 * Recoverable model behaviors are bounded by config: too many wrong guesses
 * (LLM_MAX_FAILED_GUESSES) end the run with 'failed'; the orchestrator
 * exhausting its prompt budget on repeats (LLM_MAX_DUPLICATE_GUESSES) and
 * emitting unusable output (LLM_MAX_MALFORMED_RESPONSES) end the run with
 * 'duplicate' / 'malformedResponse' statuses. Transient model/network
 * failures (LLM_MAX_MODEL_ERRORS consecutive) are retried with backoff —
 * e.g. while the Ollama model is still loading — before the run aborts
 * with 'error'.
 */
@Injectable()
export class LlmStrategyRunner {
  constructor(
    @Inject(StrategyRunStore) private readonly store: StrategyRunStore,
    @InjectRepository(Guess) private readonly guessRepo: Repository<Guess>,
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

    // Rebuild guess history from flushed guesses so a worker restart mid-run
    // resumes with the same forbidden-set context the model saw before. The
    // duplicate count (and thus the run's duplicate limit) also resumes from
    // the persisted history.
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
    const maxPrompts = llmMaxPrompts();
    const modelProvider = this.modelProviderForStrategy(strategyName);
    // A single fixed sampling temperature for the whole run. The orchestrator
    // never changes it while re-prompting — escalation is numResponses-only —
    // so this value is sent on every solve step.
    const temperature = llmTemperature();
    let consecutiveModelErrors = 0;

    let numResponses: number;

    const pendingGuesses: Partial<Guess>[] = [];
    // Every candidate proposal emitted by the orchestrator for the current
    // solve step, held until the guess it belongs to is flushed so the 'used'
    // proposal can be linked to the inserted guess row.
    const pendingProposals: Partial<LlmProposal>[] = [];

    while (true) {
      // Each solve step is a fresh guess: start from the base candidate count.
      // The temperature is fixed for the run.
      numResponses = llmNumResponses();

      const outcome = await this.orchestratorService.proposeGroup({
        puzzleWords: run.availableWords,
        priorGuesses: priorGuesses.map((guess) => ({
          words: guess.words,
          result: this.mapGuessResultToOrchestrator(guess.result),
        })),
        modelProvider,
        temperature,
        numResponses,
        maxNumResponses: MAX_LLM_NUM_RESPONSES,
        maxPrompts,
      });

      if (outcome.ok) {
        const data = outcome.data;
        consecutiveModelErrors = 0;

        // Set run-level model metadata from the first successful call.
        if (run.modelName === null) {
          run.modelName = data.model;
          run.contextWindow = data.contextWindow;
        }

        // The orchestrator re-prompted until it found a candidate that does
        // not repeat a prior guess, so the winner is the single group in the
        // response. Record the parameters that produced it; the candidate
        // count is only recorded here (the next step restarts from the base
        // value) and the temperature is fixed for the run.
        numResponses = data.numResponses;

        const group = data.proposedGroups[0];
        if (!group) {
          // Defensive: the orchestrator is not expected to return a success
          // with no candidate. Same as malformed.
          malformedCount++;
          if (malformedCount >= maxMalformed) {
            run.status = StrategyRunStatus.MALFORMED_RESPONSE;
            run.finishedAt = new Date();
          }
        } else {
          const words = group.word_ids.map((id) => run.availableWords[id]);
          const evaluation = GameService.evaluateGuessOnPuzzle(puzzle, words);

          guessCount++;
          pendingGuesses.push({
            puzzle: { id: puzzleId } as Puzzle,
            strategyRun: { id: run.id } as StrategyRun,
            words,
            result: evaluation.result,
            sequenceNumber: guessCount,
            source: GuessSource.STRATEGY,
            numResponses,
            promptAttempts: data.promptAttempts,
            duplicatesRejected: data.duplicatesRejected,
            llmDetails: this.llmDetailsFor(group, data.prompt, data.promptMetadata),
          });
          priorGuesses.push({ words, result: evaluation.result });

          // Persist every candidate the orchestrator proposed across this
          // step's prompts, not just the winner. word_ids index into the
          // run's pool before the solved words are removed below, so resolve
          // them here.
          for (const proposal of data.proposals) {
            pendingProposals.push({
              strategyRun: { id: run.id } as StrategyRun,
              solvePromptId: 0, // TODO: wire to SolvePrompt.id in follow-up
              guessNumber: guessCount,
              words: proposal.word_ids.map((id) => run.availableWords[id]),
              category: proposal.category,
              confidence: proposal.confidence,
              reasoning: proposal.reasoning,
              status: proposal.status as LlmProposalStatus,
            });
          }

          if (evaluation.result === GuessResult.SUCCESS) {
            run.availableWords = run.availableWords.filter((w) => !words.includes(w));
            run.currentCombination = firstCombination(GROUP_SIZE);

            if (run.availableWords.length === 0) {
              run.status = StrategyRunStatus.COMPLETED;
              run.finishedAt = new Date();
            }
          } else {
            // A wrong group or a one-away both count as a mistake. Mirror the
            // NYT rule of four mistakes per puzzle: once the run has made
            // maxFailedGuesses of them it is labeled 'failed'.
            failedGuessCount++;
            if (failedGuessCount >= maxFailedGuesses) {
              run.status = StrategyRunStatus.FAILED;
              run.finishedAt = new Date();
            }
          }
        }
      } else {
        const { code, details } = outcome.error;

        if (code === "model_error") {
          // A model failure is usually transient — the Ollama model is still
          // loading or the orchestrator just warmed up. Keep the run alive and
          // retry with backoff instead of killing it, so a cold-started model
          // gets time to load. Only give up after maxModelErrors consecutive
          // failures so a genuinely broken provider still ends the run.
          consecutiveModelErrors++;
          if (consecutiveModelErrors >= maxModelErrors) {
            run.status = StrategyRunStatus.ERROR;
            run.finishedAt = new Date();
          }
        } else if (code === "duplicate_group") {
          // Defensive: the orchestrator already re-prompts (requesting more
          // distinct candidates, at a fixed temperature) before it reports a
          // duplicate_group, so this means it exhausted its prompt budget.
          // The first repeated group is recorded so the duplicate limit can
          // kick in and the run terminates instead of retrying forever.
          duplicateCount++;
          // A run can end on repeats without a single usable step, so record
          // the model metadata from the error details too — otherwise a run
          // that never produces a candidate would stay anonymous.
          if (run.modelName === null && details?.model) {
            run.modelName = details.model;
            run.contextWindow = details.contextWindow ?? null;
          }
          const group = details?.proposedGroups?.[0];
          if (group) {
            const words = group.word_ids.map((id) => run.availableWords[id]);
            guessCount++;
            pendingGuesses.push({
              puzzle: { id: puzzleId } as Puzzle,
              strategyRun: { id: run.id } as StrategyRun,
              words,
              result: GuessResult.DUPLICATE,
              sequenceNumber: guessCount,
              source: GuessSource.STRATEGY,
              numResponses: details?.numResponses ?? numResponses,
              promptAttempts: details?.promptAttempts ?? 1,
              duplicatesRejected: details?.duplicatesRejected ?? 0,
              llmDetails: this.llmDetailsFor(group, details?.prompt, details?.promptMetadata),
            });
            priorGuesses.push({ words, result: GuessResult.DUPLICATE });
            // The guess recorded here is the first repeated group of the last
            // prompt, so that proposal flips from rejected_duplicate to used
            // to mark which candidate actually became the recorded guess. The
            // rest stay as the orchestrator classified them.
            const proposals = details?.proposals ?? [];
            const lastPromptNumber = Math.max(0, ...proposals.map((p) => p.promptNumber));
            const usedProposal = proposals.find(
              (p) => p.status === "rejected_duplicate" && p.promptNumber === lastPromptNumber,
            );
            for (const proposal of proposals) {
              pendingProposals.push({
                strategyRun: { id: run.id } as StrategyRun,
                solvePromptId: 0, // TODO: wire to SolvePrompt.id in follow-up
                guessNumber: guessCount,
                words: proposal.word_ids.map((id) => run.availableWords[id]),
                category: proposal.category,
                confidence: proposal.confidence,
                reasoning: proposal.reasoning,
                status:
                  proposal === usedProposal
                    ? LlmProposalStatus.USED
                    : (proposal.status as LlmProposalStatus),
              });
            }
          }

          if (duplicateCount >= maxDuplicates) {
            run.status = StrategyRunStatus.DUPLICATE;
            run.finishedAt = new Date();
          }
        } else {
          // invalid_group — the model produced output we couldn't use.
          malformedCount++;
          if (malformedCount >= maxMalformed) {
            run.status = StrategyRunStatus.MALFORMED_RESPONSE;
            run.finishedAt = new Date();
          }
        }
      }

      // Flush every iteration: LLM runs are short (tens of guesses, not
      // thousands), so batching buys nothing, and flushing each step means a
      // worker crash loses at most one step of progress.
      await this.store.flushBatch(run, pendingGuesses, pendingProposals);

      // After a transient model failure, pause before re-prompting so the
      // model has time to finish loading.
      if (run.status === StrategyRunStatus.RUNNING && consecutiveModelErrors > 0) {
        await this.delay(this.modelErrorBackoff(consecutiveModelErrors));
      }

      if (run.status !== StrategyRunStatus.RUNNING) {
        break;
      }
    }

    return { status: run.status, guessCount };
  }

  /**
   * Maps an LLM strategy name to the LLM backend it consults. The two names
   * are the UI-facing distinction; this is the only place the mapping lives so
   * the rest of the run machinery is provider-agnostic.
   */
  private modelProviderForStrategy(strategyName: string): ModelProvider {
    return strategyName === LLM_OPENAI ? "openai" : "ollama";
  }

  /**
   * Picks which of the model's candidate groups becomes the submitted guess.
   * The first candidate that is well-formed (4 unique, in-range IDs) and does
   * not repeat a previously guessed group wins. If every candidate repeats an
   * earlier guess, the first duplicate is returned so the run's duplicate
   * limit can kick in. Returns null when no candidate is usable at all.
   */
  private mapGuessResultToOrchestrator(result: GuessResult): "correct" | "incorrect" | "oneAway" {
    switch (result) {
      case GuessResult.SUCCESS:
        return "correct";
      case GuessResult.OFF_BY_ONE:
        return "oneAway";
      default:
        // FAILURE and DUPLICATE are both wrong groups.
        return "incorrect";
    }
  }

  private llmDetailsFor(
    group: { category: string; confidence: number; reasoning: string },
    prompt: string | undefined,
    promptMetadata: unknown[] | undefined,
  ): Record<string, unknown> {
    return {
      category: group.category,
      confidence: group.confidence,
      reasoning: group.reasoning,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(promptMetadata !== undefined ? { promptMetadata } : {}),
    };
  }

  /**
   * Exponential backoff (1s, 2s, 4s, ... capped at 5min) before retrying a
   * solve step after a transient model failure.
   */
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
