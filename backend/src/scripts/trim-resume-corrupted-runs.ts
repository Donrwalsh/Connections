import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import {
  SolvePrompt,
  SolvePromptStatus,
  SolvePromptType,
} from "../modules/strategy/entities/solve-prompt.entity";
import { StrategyRun, StrategyRunStatus } from "../modules/strategy/entities/strategy-run.entity";
import { LlmProposal, LlmProposalStatus } from "../modules/strategy/entities/llm-proposal.entity";
import { Guess, GuessResult } from "../modules/strategy/entities/guess.entity";
import { CategoryEvaluation } from "../modules/strategy/entities/category-evaluation.entity";
import { Puzzle } from "../modules/game/entities/puzzle.entity";
import { computeInitialWordOrder } from "../modules/strategy/strategy-run-store.service";

/**
 * One-off repair for runs corrupted by the resume bug fixed alongside this
 * script: llm-strategy-runner.service.ts's runLlmStrategy used to reset
 * `messages`/lockedInGroups/lastFailedGuess to empty on every invocation,
 * including a resumed one (the RATE_LIMITED_DAILY sweep, a manual retry, or
 * a plain worker crash-restart) — so the first prompt after any resume was
 * silently sent as a fresh INITIAL_SOLVE with no memory of the run's actual
 * progress, instead of the RETRY it should have been. See
 * llm-strategy-runner.service.ts's `runLlmStrategy` (the fix) and the PR
 * this shipped alongside for the full root-cause writeup.
 *
 * Every row from the point a run first hits this corruption onward is
 * unreliable — the model was solving with an incomplete/wrong picture of
 * the puzzle state, so its guesses can't be trusted as "the model's real
 * attempt" the way an uncorrupted run's can. This script finds that point
 * per run, deletes everything from there on (SolvePrompt cascades to
 * LlmProposal and CategoryEvaluation; Guess is deleted explicitly), and
 * resets the run to `error` with `availableWords` rolled back to its
 * pre-corruption state — so the genuinely correct progress before the
 * corruption survives, and the run becomes retryable through the now-fixed
 * manual-retry path (POST /dispatch/run/:runId/retry) instead of being lost.
 *
 * findResumeCorruption below detects the corruption by replaying each run's
 * actual state machine (same replay backfill-prompt-text.ts's
 * reconstructPromptTexts uses) and comparing the promptType the replay says
 * a row *should* be against what's actually stored — far more precise than
 * inferring a resume from a timing gap, and it doesn't need to know *why*
 * a run resumed (RATE_LIMITED_DAILY, a manual retry, or a crash all hit the
 * exact same code path and produce the exact same signature).
 *
 * SAFE BY DEFAULT: dry-run unless --apply is passed. Always prints what it
 * found/would-do; only mutates the database with --apply.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/trim-resume-corrupted-runs.ts                # dry run, every affected run
 *   npx tsx src/scripts/trim-resume-corrupted-runs.ts --apply         # apply, every affected run
 *   npx tsx src/scripts/trim-resume-corrupted-runs.ts --run-id=1234   # scope to one run
 *
 * Production/container:
 *   docker exec <container> npm run trim:resume-corrupted-runs -- --apply
 */

const logger = new Logger("TrimResumeCorruptedRuns");

export interface ResumeCorruption {
  badPromptNumber: number;
  availableWordsBeforeCorruption: string[];
  taintedGuessIds: number[];
}

/**
 * Replays one run's SolvePrompt rows in call order, rebuilding
 * availableWords/lastFailedGuess from each step's actually-submitted
 * guesses exactly like the live runner does — then flags the first row
 * whose stored promptType disagrees with what the replay says it should be.
 * That disagreement is only possible if the run's in-memory state was wiped
 * between rows (a resume), since within one continuous execution
 * lastFailedGuess only clears on a genuine SUCCESS guess (see
 * llm-strategy-runner.service.ts's evaluateProposals).
 *
 * Returns null for an uncorrupted run. `taintedGuessIds` covers every guess
 * produced by the flagged row and every row after it — the corruption
 * point onward is one contiguous unreliable tail.
 */
export function findResumeCorruption(
  originalWords: string[],
  solvePrompts: SolvePrompt[],
  proposals: LlmProposal[],
  guessesById: Map<number, Guess>,
): ResumeCorruption | null {
  const proposalsByPrompt = new Map<number, LlmProposal[]>();
  for (const proposal of proposals) {
    const list = proposalsByPrompt.get(proposal.solvePromptId) ?? [];
    list.push(proposal);
    proposalsByPrompt.set(proposal.solvePromptId, list);
  }

  const orderedPrompts = [...solvePrompts].sort(
    (a, b) => a.promptNumber - b.promptNumber || a.attemptNumber - b.attemptNumber,
  );

  let availableWords = [...originalWords];
  let lastFailedGuess: { items: string[]; result: string } | null = null;
  const taintedGuessIds: number[] = [];
  let badPromptNumber: number | null = null;
  let availableWordsBeforeCorruption: string[] | null = null;

  for (let i = 0; i < orderedPrompts.length; i++) {
    const prompt = orderedPrompts[i];

    if (badPromptNumber === null) {
      const expectedType =
        lastFailedGuess === null ? SolvePromptType.INITIAL_SOLVE : SolvePromptType.RETRY;

      // i === 0 is the run's genuine first prompt — always a legitimate
      // INITIAL_SOLVE, nothing to compare it against.
      if (i > 0 && prompt.promptType !== expectedType) {
        badPromptNumber = prompt.promptNumber;
        availableWordsBeforeCorruption = [...availableWords];
      }
    }

    if (badPromptNumber !== null) {
      for (const proposal of proposalsByPrompt.get(prompt.id) ?? []) {
        if (proposal.status === LlmProposalStatus.USED && proposal.guessId !== null) {
          taintedGuessIds.push(proposal.guessId);
        }
      }
      continue;
    }

    // A CALL_ERROR row never produced a guess — nothing to replay forward.
    if (prompt.status === SolvePromptStatus.CALL_ERROR) continue;

    const usedSteps = (proposalsByPrompt.get(prompt.id) ?? [])
      .slice()
      .sort((a, b) => a.id - b.id)
      .filter((p) => p.status === LlmProposalStatus.USED && p.guessId !== null)
      .map((p) => ({ words: p.words, guess: guessesById.get(p.guessId!) }))
      .filter((s): s is { words: string[]; guess: Guess } => s.guess !== undefined)
      .sort((a, b) => a.guess.sequenceNumber - b.guess.sequenceNumber);

    for (const step of usedSteps) {
      if (step.guess.result === GuessResult.SUCCESS) {
        availableWords = availableWords.filter((word) => !step.words.includes(word));
        lastFailedGuess = null;
      } else {
        const resultStr = step.guess.result === GuessResult.OFF_BY_ONE ? "one away" : "incorrect";
        lastFailedGuess = { items: step.words, result: resultStr };
      }
    }
  }

  if (badPromptNumber === null) return null;

  return {
    badPromptNumber,
    availableWordsBeforeCorruption: availableWordsBeforeCorruption!,
    taintedGuessIds,
  };
}

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const runIdArg = argv.find((a) => a.startsWith("--run-id="));
  const runId = runIdArg ? Number(runIdArg.slice("--run-id=".length)) : undefined;
  return { apply, runId };
}

async function main() {
  const { apply, runId } = parseArgs(process.argv.slice(2));

  // Dynamic import — see backfill-prompt-text.ts's identical comment: loading
  // AppModule eagerly runs env-var validation, which must not happen just by
  // importing this file's pure exports (e.g. from this script's spec).
  const { AppModule } = await import("../app.module");
  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const dataSource = appContext.get(DataSource);
    const solvePromptRepo = dataSource.getRepository(SolvePrompt);
    const strategyRunRepo = dataSource.getRepository(StrategyRun);
    const llmProposalRepo = dataSource.getRepository(LlmProposal);
    const guessRepo = dataSource.getRepository(Guess);
    const categoryEvaluationRepo = dataSource.getRepository(CategoryEvaluation);
    const puzzleRepo = dataSource.getRepository(Puzzle);

    const runIdsWithPrompts = await solvePromptRepo
      .createQueryBuilder("prompt")
      .select('DISTINCT prompt."strategyRunId"', "strategyRunId")
      .getRawMany<{ strategyRunId: number }>();
    const candidateRunIds = runIdsWithPrompts
      .map((row) => row.strategyRunId)
      .filter((id) => runId === undefined || id === runId);

    logger.log(`Scanning ${candidateRunIds.length} run(s) with SolvePrompt rows.`);

    const runs = await strategyRunRepo.find({
      where: { id: In(candidateRunIds) },
      select: { id: true, puzzleId: true, strategyName: true, modelName: true, status: true },
    });

    const puzzleIds = [...new Set(runs.map((run) => run.puzzleId))];
    const puzzles = await puzzleRepo.find({
      where: { id: In(puzzleIds) },
      relations: { answerGroups: { members: true } },
    });
    const puzzleById = new Map(puzzles.map((puzzle) => [puzzle.id, puzzle]));

    let affectedCount = 0;
    let totalGuessesRemoved = 0;
    let totalSolvePromptsRemoved = 0;

    for (const run of runs) {
      const puzzle = puzzleById.get(run.puzzleId);
      if (!puzzle) {
        logger.warn(`Run ${run.id}: puzzle ${run.puzzleId} not found, skipping.`);
        continue;
      }

      const [solvePrompts, proposals, guesses] = await Promise.all([
        solvePromptRepo.find({ where: { strategyRunId: run.id } }),
        llmProposalRepo.find({ where: { strategyRunId: run.id } }),
        guessRepo.find({ where: { strategyRunId: run.id } }),
      ]);

      const guessesById = new Map(guesses.map((guess) => [guess.id, guess]));
      const originalWords = computeInitialWordOrder(puzzle, run.strategyName);
      const corruption = findResumeCorruption(originalWords, solvePrompts, proposals, guessesById);

      if (!corruption) continue;

      affectedCount++;
      const taintedSolvePromptIds = solvePrompts
        .filter((p) => p.promptNumber >= corruption.badPromptNumber)
        .map((p) => p.id);
      const taintedLlmProposalIds = proposals
        .filter((p) => taintedSolvePromptIds.includes(p.solvePromptId))
        .map((p) => p.id);
      const taintedCategoryEvaluationCount =
        taintedLlmProposalIds.length > 0
          ? await categoryEvaluationRepo.count({ where: { llmProposalId: In(taintedLlmProposalIds) } })
          : 0;

      logger.log(
        `Run ${run.id} (puzzle ${run.puzzleId}, ${run.strategyName}${run.modelName ? `/${run.modelName}` : ""}, ` +
          `currently ${run.status}): corrupted from promptNumber ${corruption.badPromptNumber} onward — ` +
          `would remove ${taintedSolvePromptIds.length} SolvePrompt row(s), ${corruption.taintedGuessIds.length} ` +
          `Guess row(s), ${taintedLlmProposalIds.length} LlmProposal row(s), ${taintedCategoryEvaluationCount} ` +
          `CategoryEvaluation row(s); reset to 'error' with ${corruption.availableWordsBeforeCorruption.length} ` +
          `availableWords.`,
      );

      totalGuessesRemoved += corruption.taintedGuessIds.length;
      totalSolvePromptsRemoved += taintedSolvePromptIds.length;

      if (!apply) continue;

      await dataSource.transaction(async (manager) => {
        if (corruption.taintedGuessIds.length > 0) {
          await manager.delete(Guess, { id: In(corruption.taintedGuessIds) });
        }
        // Cascades LlmProposal (ON DELETE CASCADE from SolvePrompt), which in
        // turn cascades CategoryEvaluation (ON DELETE CASCADE from
        // LlmProposal) — see those entities' onDelete config.
        await manager.delete(SolvePrompt, { id: In(taintedSolvePromptIds) });
        await manager.update(StrategyRun, run.id, {
          availableWords: corruption.availableWordsBeforeCorruption,
          status: StrategyRunStatus.ERROR,
          finishedAt: new Date(),
        });
      });
    }

    logger.log(
      `${apply ? "Applied" : "Dry run — would apply"}: ${affectedCount} run(s) affected, ` +
        `${totalSolvePromptsRemoved} SolvePrompt row(s), ${totalGuessesRemoved} Guess row(s).`,
    );
    if (!apply && affectedCount > 0) {
      logger.log("Re-run with --apply to make these changes.");
    }
  } finally {
    await appContext.close();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(error);
      process.exit(1);
    });
}
