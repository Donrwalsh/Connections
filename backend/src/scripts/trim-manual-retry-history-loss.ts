import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { SolvePrompt, SolvePromptStatus } from "../modules/strategy/entities/solve-prompt.entity";
import { StrategyRun, StrategyRunStatus } from "../modules/strategy/entities/strategy-run.entity";
import { LlmProposal, LlmProposalStatus } from "../modules/strategy/entities/llm-proposal.entity";
import { Guess, GuessResult } from "../modules/strategy/entities/guess.entity";
import { CategoryEvaluation } from "../modules/strategy/entities/category-evaluation.entity";
import { Puzzle } from "../modules/game/entities/puzzle.entity";
import { computeInitialWordOrder } from "../modules/strategy/strategy-run-store.service";
import { findManualRetryHistoryLoss } from "./find-manual-retry-history-loss";

/**
 * Repair for the runs find-manual-retry-history-loss.ts identifies: a
 * manually-retried run whose trigger CALL_ERROR row's requestBody was never
 * captured (fixed alongside that script — see orchestrator.service.ts), so
 * reconstructMessages seeded the retry's first prompt with an empty
 * conversation history instead of the run's real prior turns.
 *
 * There's no way to recover the lost requestBody itself — the fix only
 * stops it happening to *future* failures. What this script does instead is
 * roll the run back to its last trustworthy state (right before the trigger
 * row) and drop it back to 'error', so StrategyDispatch.retryRun's existing
 * "Manually retry" path can pick it up again — this time seeding history
 * from that last genuine successful call's own (correctly-captured)
 * requestBody, since the fixed orchestrator guarantees every row from here
 * on has one to fall back to even if the retried call fails again.
 *
 * Unlike trim-resume-corrupted-runs.ts's corruption, nothing here was ever
 * *wrong* — promptType/lockedInGroups/lastFailedGuess all stayed correct
 * throughout (they're rebuilt from Guess rows, untouched by this bug); only
 * the model's conversational context was thinner than intended from the
 * trigger row onward. Guesses made under that thinner context are still
 * discarded here rather than kept, on the same reasoning as the other
 * script: this benchmark is meant to measure the model working with its
 * full intended context, and a guess made without it isn't a fair sample of
 * that — so it's better trimmed and re-attempted than left in place.
 *
 * The trigger row itself (the CALL_ERROR that originally put the run into
 * 'error') is deleted too, not just the corrupted retry onward — if it were
 * kept, it would remain the run's last row, and its own requestBody is the
 * one that's permanently missing, so the very next retry would hit the
 * identical empty-history bug all over again. Deleting through it leaves
 * the last remaining row as the run's last genuine success, which — being a
 * success — always had its requestBody captured on the normal (unaffected)
 * success path.
 *
 * planManualRetryHistoryRepair below is the pure per-run planner: unit-tested
 * in trim-manual-retry-history-loss.spec.ts.
 *
 * SAFE BY DEFAULT: dry-run unless --apply is passed. Always prints what it
 * found/would-do; only mutates the database with --apply.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/trim-manual-retry-history-loss.ts                # dry run, every affected run
 *   npx tsx src/scripts/trim-manual-retry-history-loss.ts --apply         # apply, every affected run
 *   npx tsx src/scripts/trim-manual-retry-history-loss.ts --run-id=1234   # scope to one run
 *
 * Production/container:
 *   docker exec <container> npm run trim:manual-retry-history-loss -- --apply
 */

const logger = new Logger("TrimManualRetryHistoryLoss");

export interface ManualRetryHistoryRepair {
  // Every SolvePrompt row with promptNumber >= this is removed — the
  // trigger CALL_ERROR row itself plus the retry that inherited no history
  // from it and everything after.
  cutoffPromptNumber: number;
  availableWordsBeforeCutoff: string[];
  taintedGuessIds: number[];
}

/**
 * Builds the repair plan for one run, or null if find-manual-retry-history-
 * loss.ts's detector doesn't flag it. Replays only the guesses that stay
 * (promptNumber < the trigger row) to compute availableWords as it stood
 * right before the trigger row's own call — no promptType replay needed
 * here (unlike trim-resume-corrupted-runs.ts's findResumeCorruption): this
 * bug never made promptType/lockedInGroups/lastFailedGuess wrong, so there's
 * nothing to cross-check, only word-tracking to redo.
 */
export function planManualRetryHistoryRepair(
  originalWords: string[],
  solvePrompts: SolvePrompt[],
  proposals: LlmProposal[],
  guessesById: Map<number, Guess>,
): ManualRetryHistoryRepair | null {
  const loss = findManualRetryHistoryLoss(solvePrompts);
  if (!loss) return null;

  const proposalsByPrompt = new Map<number, LlmProposal[]>();
  for (const proposal of proposals) {
    const list = proposalsByPrompt.get(proposal.solvePromptId) ?? [];
    list.push(proposal);
    proposalsByPrompt.set(proposal.solvePromptId, list);
  }

  const orderedPrompts = [...solvePrompts].sort((a, b) => a.promptNumber - b.promptNumber);

  let availableWords = [...originalWords];
  const taintedGuessIds: number[] = [];

  for (const prompt of orderedPrompts) {
    if (prompt.promptNumber >= loss.triggerPromptNumber) {
      for (const proposal of proposalsByPrompt.get(prompt.id) ?? []) {
        if (proposal.status === LlmProposalStatus.USED && proposal.guessId !== null) {
          taintedGuessIds.push(proposal.guessId);
        }
      }
      continue;
    }

    // A CALL_ERROR row never produced a guess — nothing to replay forward.
    if (prompt.status === SolvePromptStatus.CALL_ERROR) continue;

    const usedGuesses = (proposalsByPrompt.get(prompt.id) ?? [])
      .filter((p) => p.status === LlmProposalStatus.USED && p.guessId !== null)
      .map((p) => guessesById.get(p.guessId!))
      .filter((g): g is Guess => g !== undefined)
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    for (const guess of usedGuesses) {
      if (guess.result === GuessResult.SUCCESS) {
        availableWords = availableWords.filter((word) => !guess.words.includes(word));
      }
    }
  }

  return {
    cutoffPromptNumber: loss.triggerPromptNumber,
    availableWordsBeforeCutoff: availableWords,
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

    const runIdsWithManualRetry = await solvePromptRepo
      .createQueryBuilder("prompt")
      .select('DISTINCT prompt."strategyRunId"', "strategyRunId")
      .where('prompt."manualRetry" = true')
      .getRawMany<{ strategyRunId: number }>();
    const candidateRunIds = runIdsWithManualRetry
      .map((row) => row.strategyRunId)
      .filter((id) => runId === undefined || id === runId);

    logger.log(`Scanning ${candidateRunIds.length} manually-retried run(s).`);

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
      const repair = planManualRetryHistoryRepair(originalWords, solvePrompts, proposals, guessesById);

      if (!repair) continue;

      affectedCount++;
      const taintedSolvePromptIds = solvePrompts
        .filter((p) => p.promptNumber >= repair.cutoffPromptNumber)
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
          `currently ${run.status}): manual-retry history loss from promptNumber ${repair.cutoffPromptNumber} onward — ` +
          `would remove ${taintedSolvePromptIds.length} SolvePrompt row(s), ${repair.taintedGuessIds.length} ` +
          `Guess row(s), ${taintedLlmProposalIds.length} LlmProposal row(s), ${taintedCategoryEvaluationCount} ` +
          `CategoryEvaluation row(s); reset to 'error' with ${repair.availableWordsBeforeCutoff.length} ` +
          `availableWords, ready for another manual retry under the fix.`,
      );

      totalGuessesRemoved += repair.taintedGuessIds.length;
      totalSolvePromptsRemoved += taintedSolvePromptIds.length;

      if (!apply) continue;

      await dataSource.transaction(async (manager) => {
        if (repair.taintedGuessIds.length > 0) {
          await manager.delete(Guess, { id: In(repair.taintedGuessIds) });
        }
        // Cascades LlmProposal (ON DELETE CASCADE from SolvePrompt), which in
        // turn cascades CategoryEvaluation (ON DELETE CASCADE from
        // LlmProposal) — see those entities' onDelete config.
        await manager.delete(SolvePrompt, { id: In(taintedSolvePromptIds) });
        await manager.update(StrategyRun, run.id, {
          availableWords: repair.availableWordsBeforeCutoff,
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
