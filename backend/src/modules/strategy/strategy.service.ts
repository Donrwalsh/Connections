import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import { STRATEGY_QUEUE } from "../queue/queue.module";
import { StrategyRun, StrategyRunStatus, TERMINAL_STATUSES } from "./entities/strategy-run.entity";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { Puzzle } from "../game/entities/puzzle.entity";
import { combinationToWords, firstCombination, nextCombination } from "./combinatorics";
import { Guess, GuessResult, GuessSource } from "./entities/guess.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
import { GameService } from "../game/game.service";
import { StrategyRunDetailDto, StrategyRunListItemDto, GuessDetailDto } from "./dto/strategy.dto";
import {
  LLM_OPENAI,
  LLM_OLLAMA,
  MAX_LLM_NUM_RESPONSES,
  SHUFFLE_SMART,
  SHUFFLE_FOOLISH,
  llmMaxDuplicateGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmMaxPrompts,
  llmNumResponses,
  llmTemperatureBase,
  llmTemperatureMax,
  llmTemperatureStep,
  shuffleFoolishDuplicateLimit,
  strategyTrialNumbers,
} from "../../strategies";
import { runStrategyJobId } from "../queue/strategy.queue";
import { OrchestratorService, type ModelProvider } from "./orchestrator.service";

const GROUP_SIZE = 4;
const BATCH_SIZE = 50;

// Backoff between retries of a transient model failure (e.g. the Ollama model
// still loading after a cold start). Exponential from 1s, capped at 5min.
const MODEL_ERROR_RETRY_BASE_DELAY_MS = 1000;
const MODEL_ERROR_RETRY_MAX_DELAY_MS = 300000;

@Injectable()
export class StrategyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(STRATEGY_QUEUE) private queue: Queue,
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @InjectRepository(Puzzle) private readonly puzzleRepo: Repository<Puzzle>,
    @InjectRepository(Guess) private readonly guessRepo: Repository<Guess>,
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(OrchestratorService) private readonly orchestratorService: OrchestratorService,
  ) {}

  async triggerRun(puzzleId: number, strategyName: string, date?: string, trialNumber = 0) {
    await this.queue.add(
      "run-strategy",
      {
        puzzleId,
        strategyName,
        date,
        trialNumber,
      },
      {
        // Deterministic id so duplicate enqueues of the same run collapse to a
        // single job instead of racing to create two runs.
        jobId: runStrategyJobId(puzzleId, strategyName, trialNumber),
      },
    );
  }

  /**
   * Queues one job per trial for the strategy — a single trial (0) for
   * deterministic strategies, one per shuffle-smart/shuffle-foolish trial (1..N).
   */
  async triggerStrategyRuns(puzzleId: number, strategyName: string, date: string) {
    const trialNumbers = strategyTrialNumbers(strategyName);
    await this.queue.addBulk(
      trialNumbers.map((trialNumber) => ({
        name: "run-strategy",
        data: { puzzleId, strategyName, date, trialNumber },
        opts: { jobId: runStrategyJobId(puzzleId, strategyName, trialNumber) },
      })),
    );
  }

  async getRunDetail(
    date: string,
    strategyName: string,
    trialNumber = 0,
    page = 1,
    limit = 200,
  ): Promise<StrategyRunDetailDto> {
    const puzzleId = await this.gameService.resolveDateToPuzzleId(date);

    const run = await this.strategyRunRepo.findOne({
      where: { puzzleId, strategyName, trialNumber },
    });

    if (!run) {
      throw new NotFoundException(
        `Strategy '${strategyName}' has not been run for the puzzle on${date}.`,
      );
    }

    // A deterministic run can hold ~2,400 guesses, so detail is paginated.
    // Clamp inputs to keep a single response bounded.
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
    const total = await this.countGuesses(run.id);

    const guesses = await this.guessRepo.find({
      where: { strategyRunId: run.id },
      order: { sequenceNumber: "ASC" },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
      // Restrict to the columns the detail DTO uses so the query can be
      // served as an index-only scan off the covering index.
      select: {
        strategyRunId: true,
        sequenceNumber: true,
        words: true,
        result: true,
        guessedAt: true,
      },
    });

    return {
      ...this.mapRunDetail(run, guesses),
      meta: { total, page: safePage, limit: safeLimit },
    };
  }

  /**
   * Full detail for a single guess: everything the run-detail list omits to
   * stay index-only, most notably the LLM telemetry recorded for strategy
   * guesses (prompt/completion tokens, latency, sampling parameters and the
   * free-form llmDetails). Returns nulls for non-LLM guesses. Fetched lazily
   * per guess from the frontend.
   */
  async getGuessDetail(
    date: string,
    strategyName: string,
    trialNumber = 0,
    sequenceNumber: number,
  ): Promise<GuessDetailDto> {
    const puzzleId = await this.gameService.resolveDateToPuzzleId(date);

    const run = await this.strategyRunRepo.findOne({
      where: { puzzleId, strategyName, trialNumber },
    });

    if (!run) {
      throw new NotFoundException(
        `Strategy '${strategyName}' has not been run for the puzzle on ${date}.`,
      );
    }

    const guess = await this.guessRepo.findOne({
      where: { strategyRunId: run.id, sequenceNumber },
    });

    if (!guess) {
      throw new NotFoundException(
        `Guess #${sequenceNumber} not found for strategy '${strategyName}' on the puzzle dated ${date}.`,
      );
    }

    return {
      sequenceNumber: guess.sequenceNumber,
      words: guess.words,
      result: guess.result,
      guessedAt: guess.guessedAt,
      promptTokens: guess.promptTokens,
      completionTokens: guess.completionTokens,
      totalTokens: guess.totalTokens,
      latencyMs: guess.latencyMs,
      temperature: guess.temperature,
      numResponses: guess.numResponses,
      promptAttempts: guess.promptAttempts,
      duplicatesRejected: guess.duplicatesRejected,
      llmDetails: guess.llmDetails,
    };
  }

  /**
   * Returns run metadata plus a guess count for every trial of a strategy on
   * a puzzle — deliberately WITHOUT the full guess arrays. The list drives
   * the strategy buttons in the UI; full guesses are fetched per-run via
   * getRunDetail, which keeps responses small (a deterministic run can hold
   * ~2,400 guesses).
   */
  async getRunsForPuzzle(date: string, strategyName: string): Promise<StrategyRunListItemDto[]> {
    const puzzleId = await this.gameService.resolveDateToPuzzleId(date);

    const runs = await this.strategyRunRepo.find({
      where: { puzzleId, strategyName },
      order: { trialNumber: "ASC" },
    });

    if (runs.length === 0) {
      return [];
    }

    // Single grouped-count query instead of one COUNT per run (and without
    // loading every guess row just to count them).
    const countRows = await this.guessRepo
      .createQueryBuilder("guess")
      .select("guess.strategyRunId", "strategyRunId")
      .addSelect("COUNT(guess.id)", "count")
      .where("guess.strategyRunId IN (:...ids)", {
        ids: runs.map((run) => run.id),
      })
      .groupBy("guess.strategyRunId")
      .getRawMany<{ strategyRunId: number; count: string }>();

    const countByRun = new Map<number, number>();
    for (const row of countRows) {
      countByRun.set(Number(row.strategyRunId), Number(row.count));
    }

    return runs.map((run) => ({
      id: run.id,
      strategyName: run.strategyName,
      trialNumber: run.trialNumber,
      status: run.status,
      modelName: run.modelName,
      contextWindow: run.contextWindow,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      guessCount: countByRun.get(run.id) ?? 0,
    }));
  }

  private mapRunDetail(run: StrategyRun, guesses: Guess[]): Omit<StrategyRunDetailDto, "meta"> {
    return {
      id: run.id,
      strategyName: run.strategyName,
      trialNumber: run.trialNumber,
      status: run.status,
      modelName: run.modelName,
      contextWindow: run.contextWindow,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      guesses: guesses.map((g) => ({
        sequenceNumber: g.sequenceNumber,
        words: g.words,
        result: g.result,
        guessedAt: g.guessedAt,
      })),
    };
  }

  async runDeterministicStrategy(puzzleId: number, strategyName: string, trialNumber = 0) {
    // loadOrCreateRun loads the (immutable) puzzle alongside the run so the
    // loop below evaluates guesses in memory without a full DB reload per
    // guess (~2,400 queries per worst-case deterministic run).
    const { run, puzzle } = await this.loadOrCreateRun(puzzleId, strategyName, trialNumber);

    if (TERMINAL_STATUSES.has(run.status)) {
      return {
        status: run.status,
        guessCount: await this.countGuesses(run.id),
      };
    }

    let guessCount: number;
    const triedGroups = new Set<string>();
    let duplicateCount = 0;
    const tracksDuplicates = strategyName === SHUFFLE_SMART || strategyName === SHUFFLE_FOOLISH;
    if (tracksDuplicates) {
      // Shuffle-smart re-rolls until it finds a group it hasn't already
      // proposed; shuffle-foolish records repeated groups as 'duplicate'
      // guesses so the run can be terminated once the duplicate limit is hit.
      // Both rebuild their tried set from guesses flushed to the DB (e.g.
      // after a worker restart mid-run). The single query below doubles as
      // the guess count.
      const priorGuesses = await this.loadGuessesForRun(run.id);
      guessCount = priorGuesses.length;
      for (const guess of priorGuesses) {
        triedGroups.add(this.groupKey(guess.words));
      }
    } else {
      guessCount = await this.countGuesses(run.id);
    }

    const pendingGuesses: Partial<Guess>[] = [];

    while (true) {
      let words: string[] = [];
      let noMoreGroups = false;
      let isDuplicate = false;

      switch (strategyName) {
        case "alphabetical":
        case "reverse-alphabetical":
        case "order":
        case "reverse-order":
          words = combinationToWords(run.currentCombination, run.availableWords);
          break;
        case SHUFFLE_SMART: {
          const picked = this.pickRandomGroup(run.availableWords, triedGroups);
          if (picked === null) {
            run.status = StrategyRunStatus.FAILED;
            run.finishedAt = new Date();
            noMoreGroups = true;
          } else {
            words = picked;
          }
          break;
        }
        case SHUFFLE_FOOLISH:
          // Pure random picks. Unlike shuffle-smart, repeats are NOT re-rolled
          // — they are recorded as 'duplicate' guesses, so an unlucky run
          // terminates once it repeats the same group
          // SHUFFLE_FOOLISH_DUPLICATE_LIMIT times instead of grinding forever.
          words = this.sampleRandom(run.availableWords, GROUP_SIZE);
          isDuplicate = triedGroups.has(this.groupKey(words));
          break;
        default:
          throw new BadRequestException(`Unsupported strategy name: '${strategyName}'`);
      }

      if (!noMoreGroups) {
        guessCount++;

        if (isDuplicate) {
          duplicateCount++;
          pendingGuesses.push({
            puzzle: { id: puzzleId } as Puzzle,
            strategyRun: { id: run.id } as StrategyRun,
            words,
            result: GuessResult.DUPLICATE,
            sequenceNumber: guessCount,
            source: GuessSource.STRATEGY,
          });

          if (duplicateCount >= shuffleFoolishDuplicateLimit()) {
            run.status = StrategyRunStatus.DUPLICATE;
            run.finishedAt = new Date();
          }
        } else {
          const evaluation = GameService.evaluateGuessOnPuzzle(puzzle, words);

          if (strategyName === SHUFFLE_SMART || strategyName === SHUFFLE_FOOLISH) {
            triedGroups.add(this.groupKey(words));
          }

          // Stage the guess in memory
          pendingGuesses.push({
            puzzle: { id: puzzleId } as Puzzle,
            strategyRun: { id: run.id } as StrategyRun,
            words,
            result: evaluation.result,
            sequenceNumber: guessCount,
            source: GuessSource.STRATEGY,
          });

          // Update in-memory state
          if (evaluation.result === GuessResult.SUCCESS) {
            run.availableWords = run.availableWords.filter((w) => !words.includes(w));
            run.currentCombination = firstCombination(GROUP_SIZE);

            if (run.availableWords.length === 0) {
              run.status = StrategyRunStatus.COMPLETED;
              run.finishedAt = new Date();
            }
          } else if (strategyName !== SHUFFLE_SMART && strategyName !== SHUFFLE_FOOLISH) {
            const next = nextCombination(run.currentCombination, run.availableWords.length);

            if (next === null) {
              run.status = StrategyRunStatus.FAILED;
              run.finishedAt = new Date();
            } else {
              run.currentCombination = next;
            }
          }
        }
      }

      const isFinished = run.status !== StrategyRunStatus.RUNNING;
      const reachedBatchLimit = pendingGuesses.length >= BATCH_SIZE;

      // Flush to DB if batch size reached or run completed/failed
      if (reachedBatchLimit || isFinished) {
        await this.flushBatch(run, pendingGuesses);
      }

      if (isFinished) {
        break;
      }
    }

    return { status: run.status, guessCount };
  }

  /**
   * Iterative LLM strategy: calls the orchestrator's /solve with the remaining
   * words plus the full guess history. The strategy name (llm-openai or
   * llm-ollama) selects which LLM backend the orchestrator consults for every
   * solve step. Each step starts by asking the model for a single answer; when
   * every candidate repeats a prior guess, the orchestrator re-prompts with
   * changed parameters — alternating between a higher sampling temperature and
   * more distinct candidates to choose from — until a fresh candidate appears
   * or its prompt budget runs out. The parameters that produced a usable
   * candidate are held onto here and sent on subsequent steps, so the
   * escalation persists across the run.
   *
   * Recoverable model behaviors are bounded by config: the orchestrator
   * exhausting its prompt budget on repeats (LLM_MAX_DUPLICATE_GUESSES) and
   * emitting unusable output (LLM_MAX_MALFORMED_RESPONSES) end the run with
   * 'duplicate' / 'malformedResponse' statuses. Transient model/network
   * failures (LLM_MAX_MODEL_ERRORS consecutive) are retried with backoff —
   * e.g. while the Ollama model is still loading — before the run aborts
   * with 'error'.
   */
  async runLlmStrategy(puzzleId: number, strategyName: string, trialNumber = 0) {
    const { run, puzzle } = await this.loadOrCreateRun(puzzleId, strategyName, trialNumber);

    if (TERMINAL_STATUSES.has(run.status)) {
      return {
        status: run.status,
        guessCount: await this.countGuesses(run.id),
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
    let malformedCount = 0;
    const maxDuplicates = llmMaxDuplicateGuesses();
    const maxMalformed = llmMaxMalformedResponses();
    const maxModelErrors = llmMaxModelErrors();
    const maxPrompts = llmMaxPrompts();
    // The temperature ramp ceiling (and per-re-prompt step) is provider-
    // specific: OpenAI ranges 0 -> 0.5, Ollama 0 -> 1.5.
    const modelProvider = this.modelProviderForStrategy(strategyName);
    const temperatureStep = llmTemperatureStep(process.env, modelProvider);
    const maxTemperature = llmTemperatureMax(process.env, modelProvider);
    let consecutiveModelErrors = 0;

    // Sticky sampling temperature. The orchestrator reports the temperature
    // that produced each guess; we hold onto it so later solve steps start
    // from the escalated value instead of resetting. (A worker restart
    // mid-run resets it to base — the orchestrator simply re-escalates on
    // demand.) The candidate count, by contrast, restarts from the base value
    // on every solve step so each guess gets a fresh shot at a single answer.
    let temperature = llmTemperatureBase();
    let numResponses: number;

    const pendingGuesses: Partial<Guess>[] = [];
    // Every candidate proposal emitted by the orchestrator for the current
    // solve step, held until the guess it belongs to is flushed so the 'used'
    // proposal can be linked to the inserted guess row.
    const pendingProposals: Partial<LlmProposal>[] = [];

    while (true) {
      // Each solve step is a fresh guess: start from the base candidate count
      // (the temperature stays sticky across the run).
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
        temperatureStep,
        maxTemperature,
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
        // response. Hold onto the temperature that produced it so the next
        // solve step starts from it; the escalated candidate count is only
        // recorded here (the next step restarts from the base value).
        temperature = data.temperature;
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
            promptTokens: data.usage.promptTokens,
            completionTokens: data.usage.completionTokens,
            totalTokens: data.usage.totalTokens,
            latencyMs: data.latencyMs,
            temperature,
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
              promptNumber: proposal.promptNumber,
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
          // Defensive: the orchestrator already re-prompts (raising the
          // temperature and requesting more distinct candidates) before it
          // reports a duplicate_group, so this means it exhausted its prompt
          // budget. The first repeated group is recorded so the duplicate
          // limit can kick in and the run terminates instead of retrying
          // forever.
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
              promptTokens: details?.usage?.promptTokens ?? null,
              completionTokens: details?.usage?.completionTokens ?? null,
              totalTokens: details?.usage?.totalTokens ?? null,
              latencyMs: details?.latencyMs ?? null,
              temperature: details?.temperature ?? temperature,
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
                promptNumber: proposal.promptNumber,
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
      await this.flushBatch(run, pendingGuesses, pendingProposals);

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
   * limit (and temperature ramp) can kick in. Returns null when no candidate
   * is usable at all.
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
   * Randomly select GROUP_SIZE words from the pool, re-rolling until the
   * selected group hasn't been tried before in this run. Returns null when
   * every possible group has already been proposed.
   */
  private pickRandomGroup(pool: string[], tried: Set<string>): string[] | null {
    if (pool.length < GROUP_SIZE) return null;

    const totalCombos = this.combinationCount(pool.length, GROUP_SIZE);

    // Rejection sampling with a generous cap — the expected number of attempts
    // stays well under this until the tried set is nearly full. Tried groups
    // from earlier (larger) pools can't be sampled anymore, so a pool-shrinking
    // solve never trips this up; it only gives up once no fresh group turns up.
    for (let attempt = 0; attempt < totalCombos * 10; attempt++) {
      const group = this.sampleRandom(pool, GROUP_SIZE);
      if (!tried.has(this.groupKey(group))) return group;
    }

    return null;
  }

  private sampleRandom<T>(pool: T[], k: number): T[] {
    const copy = [...pool];
    // Partial Fisher-Yates: shuffle the last k positions, then take them.
    for (let i = copy.length - 1; i >= copy.length - k; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(copy.length - k);
  }

  private groupKey(words: string[]): string {
    return [...words].sort().join("|");
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

  private combinationCount(n: number, k: number): number {
    let result = 1;
    for (let i = 0; i < k; i++) {
      result = (result * (n - i)) / (i + 1);
    }
    return Math.floor(result);
  }

  private async loadGuessesForRun(strategyRunId: number): Promise<Guess[]> {
    return this.guessRepo.find({
      where: { strategyRunId },
      select: { words: true },
    });
  }

  private async loadLlmGuessesForRun(strategyRunId: number): Promise<Guess[]> {
    return this.guessRepo.find({
      where: { strategyRunId },
      order: { sequenceNumber: "ASC" },
      select: { words: true, result: true },
    });
  }

  private async flushBatch(
    run: StrategyRun,
    pendingGuesses: Partial<Guess>[],
    pendingProposals: Partial<LlmProposal>[] = [],
  ): Promise<void> {
    // Create a shallow copy to insert and clear the original buffer. The run is
    // always saved — even with no new guesses — so terminal states reached
    // without a recorded guess (e.g. LLM malformed/error limits) persist.
    const guessesToInsert = [...pendingGuesses];
    pendingGuesses.length = 0;
    const proposalsToInsert = [...pendingProposals];
    pendingProposals.length = 0;

    await this.dataSource.transaction(async (manager) => {
      // Proposals are flushed together with the guess they belong to (one solve
      // step per flush), so a single inserted guess id links the 'used'
      // proposal to the guess that realized it.
      let insertedGuessId: number | undefined;
      if (guessesToInsert.length > 0) {
        const result = await manager.insert("Guess", guessesToInsert);
        insertedGuessId = result?.identifiers?.[0]?.id;
      }

      if (proposalsToInsert.length > 0) {
        await manager.insert(
          "LlmProposal",
          proposalsToInsert.map((proposal) =>
            proposal.status === LlmProposalStatus.USED && insertedGuessId !== undefined
              ? { ...proposal, guess: { id: insertedGuessId } as Guess }
              : proposal,
          ),
        );
      }
      await manager.save(StrategyRun, run);
    });
  }

  private async loadOrCreateRun(
    puzzleId: number,
    strategyName: string,
    trialNumber = 0,
  ): Promise<{ run: StrategyRun; puzzle: Puzzle }> {
    const puzzle = await this.puzzleRepo.findOne({
      where: { id: puzzleId },
      relations: { answerGroups: { members: true } },
    });

    if (!puzzle) throw new NotFoundException(`No puzzle with id: ${puzzleId}`);

    const existing = await this.strategyRunRepo.findOne({
      where: { puzzle: { id: puzzleId }, strategyName, trialNumber },
    });

    if (existing) {
      return { run: existing, puzzle };
    }

    let allWords: string[];

    switch (strategyName) {
      case "order":
      case SHUFFLE_SMART:
      case SHUFFLE_FOOLISH:
      case LLM_OPENAI:
      case LLM_OLLAMA:
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members)
          .sort((a, b) => a.position - b.position)
          .map((m) => m.word);
        break;

      case "reverse-order":
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members)
          .sort((a, b) => b.position - a.position)
          .map((m) => m.word);
        break;

      case "reverse-alphabetical":
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members.map((m) => m.word))
          .sort((a, b) => b.localeCompare(a));
        break;

      case "alphabetical":
      default:
        allWords = puzzle.answerGroups
          .flatMap((group) => group.members.map((m) => m.word))
          .sort((a, b) => a.localeCompare(b));
        break;
    }

    const run = this.strategyRunRepo.create({
      puzzle,
      strategyName,
      trialNumber,
      status: StrategyRunStatus.RUNNING,
      availableWords: allWords,
      currentCombination: firstCombination(GROUP_SIZE),
    });

    const saved = await this.strategyRunRepo.save(run);
    return { run: saved, puzzle };
  }

  private async countGuesses(strategyRunId: number): Promise<number> {
    // Plain indexed-column filter instead of a relation predicate so TypeORM
    // doesn't emit an unnecessary join/subquery.
    return this.guessRepo.count({
      where: { strategyRunId },
    });
  }
}
