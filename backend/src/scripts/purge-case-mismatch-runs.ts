import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { StrategyRun } from "../modules/strategy/entities/strategy-run.entity";
import { LlmProposal, LlmProposalStatus } from "../modules/strategy/entities/llm-proposal.entity";
import { Puzzle } from "../modules/game/entities/puzzle.entity";
import { findCaseInsensitiveGroupMatch } from "../modules/strategy/case-insensitive-match";

/**
 * One-off purge for StrategyRun rows tainted by the pre-fix case-sensitivity
 * bug in evaluateProposals (llm-strategy-runner.service.ts): a proposal
 * whose words were the right words in the wrong case was silently dropped
 * (never became a Guess) and, depending on batching, sometimes tagged
 * wordNotOnList even though every word really was on the puzzle. The live
 * code no longer does this (see case-insensitive-match.ts) — but existing
 * runs recorded under the old behavior are unreliable, so this deletes them
 * outright (cascading to their Guess/SolvePrompt/LlmProposal rows via the
 * existing onDelete: CASCADE FKs) rather than trying to patch their
 * recorded outcome in place. Deleting a StrategyRun makes its
 * (puzzleId, strategyName, trialNumber) eligible for a fresh dispatch under
 * the fixed code (see strategy-dispatch.service.ts's "no StrategyRun row at
 * all" query) — redispatch itself is a separate, manual step.
 *
 * Every status is in scope (failed, completed, running, error) — token cost
 * of redoing them is not a concern, and even a `completed` run wasted a
 * guess on the dropped proposal before eventually solving it another way.
 *
 * Dry run by default — lists affected StrategyRun ids without deleting
 * anything. Pass --execute to actually delete.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/purge-case-mismatch-runs.ts
 *   npx tsx src/scripts/purge-case-mismatch-runs.ts --execute
 *
 * Production/container:
 *   docker exec <container> npx tsx src/scripts/purge-case-mismatch-runs.ts --execute
 */

const logger = new Logger("PurgeCaseMismatchRuns");

export interface CaseMismatchProposalRow {
  strategyRunId: number;
  puzzleId: number;
  words: string[];
}

/**
 * Every distinct StrategyRun id with at least one not_selected proposal
 * whose words match one of its puzzle's answer groups only after
 * lowercasing — i.e. a proposal the old code wrongly dropped for casing.
 */
export function findCaseMismatchAffectedRunIds(
  notSelectedProposals: CaseMismatchProposalRow[],
  answerGroupsByPuzzleId: Map<number, string[][]>,
): Set<number> {
  const affected = new Set<number>();
  for (const proposal of notSelectedProposals) {
    const answerGroups = answerGroupsByPuzzleId.get(proposal.puzzleId);
    if (!answerGroups) continue;
    if (findCaseInsensitiveGroupMatch(proposal.words, answerGroups)) {
      affected.add(proposal.strategyRunId);
    }
  }
  return affected;
}

async function main() {
  const execute = process.argv.includes("--execute");
  // Dynamic import (not a static top-level one): AppModule's decorator
  // eagerly runs ConfigModule.forRoot()'s env-var validation the instant the
  // module is loaded, which would otherwise blow up importing this file at
  // all — including purge-case-mismatch-runs.spec.ts importing this file's pure
  // exports without ever calling main(). Deferring the import to here means
  // it only loads when this script is actually run.
  const { AppModule } = await import("../app.module");
  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const dataSource = appContext.get(DataSource);
    const strategyRunRepo = dataSource.getRepository(StrategyRun);
    const llmProposalRepo = dataSource.getRepository(LlmProposal);
    const puzzleRepo = dataSource.getRepository(Puzzle);

    const notSelected = await llmProposalRepo.find({
      where: { status: LlmProposalStatus.NOT_SELECTED },
      select: { strategyRunId: true, words: true },
    });
    logger.log(`Checking ${notSelected.length} not_selected proposal(s) for case-mismatch matches.`);

    if (notSelected.length === 0) {
      return;
    }

    const strategyRunIds = [...new Set(notSelected.map((p) => p.strategyRunId))];
    const runs = await strategyRunRepo.find({
      where: { id: In(strategyRunIds) },
      select: { id: true, puzzleId: true, modelName: true, status: true },
    });
    const runById = new Map(runs.map((r) => [r.id, r]));

    const puzzleIds = [...new Set(runs.map((r) => r.puzzleId))];
    const puzzles = await puzzleRepo.find({
      where: { id: In(puzzleIds) },
      relations: { answerGroups: { members: true } },
    });
    const answerGroupsByPuzzleId = new Map(
      puzzles.map((puzzle) => [
        puzzle.id,
        puzzle.answerGroups.map((group) => group.members.map((member) => member.word)),
      ]),
    );

    const proposalRows: CaseMismatchProposalRow[] = notSelected
      .map((p) => {
        const run = runById.get(p.strategyRunId);
        return run ? { strategyRunId: p.strategyRunId, puzzleId: run.puzzleId, words: p.words } : null;
      })
      .filter((row): row is CaseMismatchProposalRow => row !== null);

    const affectedRunIds = findCaseMismatchAffectedRunIds(proposalRows, answerGroupsByPuzzleId);

    logger.log(`${affectedRunIds.size} StrategyRun row(s) affected by the case-mismatch bug.`);
    for (const id of affectedRunIds) {
      const run = runById.get(id);
      logger.log(`  StrategyRun ${id}: model=${run?.modelName} puzzleId=${run?.puzzleId} status=${run?.status}`);
    }

    if (affectedRunIds.size === 0) {
      return;
    }

    if (!execute) {
      logger.log("Dry run only — pass --execute to actually delete these rows.");
      return;
    }

    const result = await strategyRunRepo.delete({ id: In([...affectedRunIds]) });
    logger.log(
      `Deleted ${result.affected ?? 0} StrategyRun row(s) (cascades to their Guess/SolvePrompt/LlmProposal rows).`,
    );
  } finally {
    await appContext.close();
  }
}

// Only run when invoked directly (npx tsx / node), not when
// purge-case-mismatch-runs.spec.ts imports this file's pure exports —
// importing it must never boot a Nest application context.
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(error);
      process.exit(1);
    });
}
