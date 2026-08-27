import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { DataSource, In, IsNull, Not } from "typeorm";
import { AppModule } from "../app.module";
import { SolvePrompt, SolvePromptIssueTag } from "../modules/strategy/entities/solve-prompt.entity";
import { StrategyRun } from "../modules/strategy/entities/strategy-run.entity";
import { LlmProposal } from "../modules/strategy/entities/llm-proposal.entity";
import { Puzzle } from "../modules/game/entities/puzzle.entity";
import { parseGroupsSection } from "../modules/strategy/parse-groups-section";

/**
 * One-off backfill for SolvePrompt rows written before groupCountOff/
 * wordNotOnList/unclassified detection existed (see
 * docs/superpowers/specs/2026-08-26-llm-failure-taxonomy-design.md). Those
 * rows only ever got parentheticalStripped (already backfilled by the
 * 1774000000000-add-solve-prompt-issue-tags migration, from the old
 * wordsHadParenthetical boolean) — this re-derives the other three tags
 * from data every historical row already has: rawResponseText (re-parsed
 * with the exact same parseGroupsSection used live) and each step's stored
 * LlmProposal rows (checked against the puzzle's real word set).
 *
 * Idempotent: recomputes deterministically and only writes rows whose tag
 * set actually changes, so re-running it is always safe.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/backfill-issue-tags.ts
 *
 * Production/container:
 *   docker exec <container> npx tsx src/scripts/backfill-issue-tags.ts
 */

const logger = new Logger("BackfillIssueTags");

async function main() {
  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const dataSource = appContext.get(DataSource);
    const solvePromptRepo = dataSource.getRepository(SolvePrompt);
    const strategyRunRepo = dataSource.getRepository(StrategyRun);
    const llmProposalRepo = dataSource.getRepository(LlmProposal);
    const puzzleRepo = dataSource.getRepository(Puzzle);

    // CALL_ERROR rows have no rawResponseText — nothing to re-parse, and
    // they're already correctly excluded from issueTags (see
    // buildCallErrorPromptRow, which never sets it).
    const prompts = await solvePromptRepo.find({
      where: { rawResponseText: Not(IsNull()) },
      select: { id: true, strategyRunId: true, rawResponseText: true, issueTags: true },
    });
    logger.log(`Found ${prompts.length} SolvePrompt row(s) with response text to re-check.`);

    if (prompts.length === 0) {
      return;
    }

    // Resolve each prompt's puzzle word set, batched rather than per-row:
    // strategyRunId -> puzzleId, then puzzleId -> the puzzle's full set of
    // real words (via AnswerGroup -> GroupMember, the same relation
    // StrategyRunStore.loadOrCreateRun eagerly loads for a live run).
    const strategyRunIds = [...new Set(prompts.map((p) => p.strategyRunId))];
    const runs = await strategyRunRepo.find({
      where: { id: In(strategyRunIds) },
      select: { id: true, puzzleId: true },
    });
    const puzzleIdByRunId = new Map(runs.map((r) => [r.id, r.puzzleId]));

    const puzzleIds = [...new Set(runs.map((r) => r.puzzleId))];
    const puzzles = await puzzleRepo.find({
      where: { id: In(puzzleIds) },
      relations: { answerGroups: { members: true } },
    });
    const wordSetByPuzzleId = new Map(
      puzzles.map((puzzle) => [
        puzzle.id,
        new Set(puzzle.answerGroups.flatMap((group) => group.members.map((member) => member.word))),
      ]),
    );

    // Every proposed group for every prompt in scope, grouped by
    // solvePromptId — this is what wordNotOnList checks against.
    const promptIds = prompts.map((p) => p.id);
    const proposals = await llmProposalRepo.find({
      where: { solvePromptId: In(promptIds) },
      select: { solvePromptId: true, words: true },
    });
    const proposalWordsByPromptId = new Map<number, string[][]>();
    for (const proposal of proposals) {
      const existing = proposalWordsByPromptId.get(proposal.solvePromptId) ?? [];
      existing.push(proposal.words);
      proposalWordsByPromptId.set(proposal.solvePromptId, existing);
    }

    let updatedCount = 0;
    const addedCountByTag = new Map<string, number>();

    for (const prompt of prompts) {
      const parsed = parseGroupsSection(prompt.rawResponseText ?? "", []);
      const tags = new Set(prompt.issueTags);
      for (const tag of parsed.issueTags) {
        tags.add(tag);
      }

      const puzzleId = puzzleIdByRunId.get(prompt.strategyRunId);
      const puzzleWords = puzzleId !== undefined ? wordSetByPuzzleId.get(puzzleId) : undefined;
      if (puzzleWords) {
        const proposalWordGroups = proposalWordsByPromptId.get(prompt.id) ?? [];
        const hasHallucinatedWord = proposalWordGroups.some((words) =>
          words.some((word) => !puzzleWords.has(word)),
        );
        if (hasHallucinatedWord) {
          tags.add(SolvePromptIssueTag.WORD_NOT_ON_LIST);
        }
      }

      const mergedTags = Array.from(tags);
      const changed =
        mergedTags.length !== prompt.issueTags.length ||
        mergedTags.some((tag) => !prompt.issueTags.includes(tag));
      if (!changed) {
        continue;
      }

      await solvePromptRepo.update(prompt.id, { issueTags: mergedTags });
      updatedCount++;
      for (const tag of mergedTags) {
        if (!prompt.issueTags.includes(tag)) {
          addedCountByTag.set(tag, (addedCountByTag.get(tag) ?? 0) + 1);
        }
      }
    }

    logger.log(`Updated ${updatedCount} of ${prompts.length} row(s).`);
    for (const [tag, count] of addedCountByTag) {
      logger.log(`  +${count} row(s) newly tagged "${tag}"`);
    }
  } finally {
    await appContext.close();
  }
}

// appContext.close() does not close the app's BullMQ queues (module-scope
// singletons with no onModuleDestroy), so their ioredis connections keep the
// event loop alive. Exit explicitly instead of relying on natural exit.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error);
    process.exit(1);
  });
