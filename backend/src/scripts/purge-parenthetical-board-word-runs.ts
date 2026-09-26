import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { StrategyRun, StrategyRunStatus } from "../modules/strategy/entities/strategy-run.entity";
import { Guess } from "../modules/strategy/entities/guess.entity";
import { CategoryEvaluation } from "../modules/strategy/entities/category-evaluation.entity";
import { Puzzle } from "../modules/game/entities/puzzle.entity";
import { isLlmStrategy } from "../strategies";

/**
 * One-off purge for LLM StrategyRun rows on the two puzzles whose board
 * words the pre-fix answer parser (packages/answer-grammar) mangled. Both
 * are image puzzles, whose words are the cards' alt text:
 *   - 2024-12-12: "TEE (GOLF)", "TEE (SHIRT)", "TI (MUSICAL NOTE)" — the
 *     parser stripped each "(...)" as a model aside, so the proposal no
 *     longer matched the board and was skipped as wordNotOnList.
 *   - 2025-04-01: literal "(" and ")" cards — "Words: (, ), O, P" had
 *     "(, )" stripped as one parenthetical, leaving a 2-word group dropped
 *     as groupCountOff.
 * Neither group could ever be solved, so every LLM run on either day was
 * scored against an impossible puzzle — whatever its status, it's deleted
 * rather than patched in place. The parser now protects board words (see
 * parseAnswer's boardWords). Non-LLM strategies never go through the parser
 * and are left alone.
 *
 * The dates are hard-coded (from a scan of the whole puzzle cache) rather
 * than detected, so the purge can never widen past these two days.
 *
 * SolvePrompt and LlmProposal rows cascade from StrategyRun; CategoryEvaluation
 * and Guess are deleted explicitly first, same as StrategyRunStore.deleteRun
 * (Guess.strategyRunId is ON DELETE SET NULL, so a StrategyRun delete alone
 * would leave its guesses behind as orphans). Deleting a run frees its
 * (puzzleId, strategyName, trialNumber) for a fresh dispatch — requeueing is
 * a separate, manual step.
 *
 * Refuses to delete anything while any affected run is still 'running' —
 * stop it first rather than racing the worker still writing to it.
 *
 * Dry run by default — lists affected runs without deleting anything. Pass
 * --execute to actually delete.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/purge-parenthetical-board-word-runs.ts
 *   npx tsx src/scripts/purge-parenthetical-board-word-runs.ts --execute
 *
 * Production/container:
 *   docker exec <container> npm run purge:parenthetical-board-word-runs -- --execute
 */

const logger = new Logger("PurgeParentheticalBoardWordRuns");

export const AFFECTED_PUZZLE_DATES = ["2024-12-12", "2025-04-01"] as const;

export interface CandidateRun {
  id: number;
  strategyName: string;
  status: StrategyRunStatus;
}

/**
 * Splits the runs on the affected puzzles into the LLM runs to delete and,
 * among those, any still running (which block the whole purge). Non-LLM
 * runs are dropped entirely.
 */
export function selectRunsToPurge<T extends CandidateRun>(
  runs: T[],
): { toDelete: T[]; stillRunning: T[] } {
  const toDelete = runs.filter((run) => isLlmStrategy(run.strategyName));
  const stillRunning = toDelete.filter((run) => run.status === StrategyRunStatus.RUNNING);
  return { toDelete, stillRunning };
}

async function main() {
  const execute = process.argv.includes("--execute");
  // Dynamic import — see purge-case-mismatch-runs.ts: loading AppModule
  // eagerly runs env validation, which must not happen when the spec
  // imports this file's pure exports.
  const { AppModule } = await import("../app.module");
  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const dataSource = appContext.get(DataSource);

    const puzzles = await dataSource.getRepository(Puzzle).find({
      where: { date: In([...AFFECTED_PUZZLE_DATES]) },
      select: { id: true, date: true },
    });
    const dateByPuzzleId = new Map(puzzles.map((puzzle) => [puzzle.id, puzzle.date]));
    logger.log(
      `Found ${puzzles.length} of ${AFFECTED_PUZZLE_DATES.length} affected puzzle(s): ` +
        (puzzles.map((p) => `${p.date} (id ${p.id})`).join(", ") || "none"),
    );
    if (puzzles.length === 0) {
      return;
    }

    const runs = await dataSource.getRepository(StrategyRun).find({
      where: { puzzleId: In(puzzles.map((p) => p.id)) },
      select: {
        id: true,
        puzzleId: true,
        strategyName: true,
        trialNumber: true,
        modelName: true,
        status: true,
      },
      order: { puzzleId: "ASC", strategyName: "ASC", modelName: "ASC", trialNumber: "ASC" },
    });
    const { toDelete, stillRunning } = selectRunsToPurge(runs);

    logger.log(`${toDelete.length} LLM StrategyRun row(s) on the affected puzzles.`);
    for (const run of toDelete) {
      logger.log(
        `  StrategyRun ${run.id}: date=${dateByPuzzleId.get(run.puzzleId)} strategy=${run.strategyName} ` +
          `model=${run.modelName} trial=${run.trialNumber} status=${run.status}`,
      );
    }

    if (toDelete.length === 0) {
      return;
    }

    if (stillRunning.length > 0) {
      logger.error(
        `Refusing to delete: ${stillRunning.length} run(s) still running ` +
          `(${stillRunning.map((run) => run.id).join(", ")}). Stop them first.`,
      );
      process.exitCode = 1;
      return;
    }

    if (!execute) {
      logger.log("Dry run only — pass --execute to actually delete these rows.");
      return;
    }

    const runIds = toDelete.map((run) => run.id);
    await dataSource.transaction(async (manager) => {
      const evaluationResult = await manager.delete(CategoryEvaluation, {
        strategyRunId: In(runIds),
      });
      const guessResult = await manager.delete(Guess, { strategyRunId: In(runIds) });
      const runResult = await manager.delete(StrategyRun, { id: In(runIds) });
      logger.log(
        `Deleted ${runResult.affected ?? 0} StrategyRun row(s), ${guessResult.affected ?? 0} Guess row(s) and ` +
          `${evaluationResult.affected ?? 0} CategoryEvaluation row(s) explicitly, ` +
          `and their SolvePrompt/LlmProposal rows via cascade.`,
      );
    });
  } finally {
    await appContext.close();
  }
}

// Only run when invoked directly, never when the spec imports this file.
if (require.main === module) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error) => {
      logger.error(error);
      process.exit(1);
    });
}
