import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { DataSource, In, IsNull } from "typeorm";
import { SolvePrompt, SolvePromptStatus, SolvePromptType } from "../modules/strategy/entities/solve-prompt.entity";
import { StrategyRun } from "../modules/strategy/entities/strategy-run.entity";
import { LlmProposal, LlmProposalStatus } from "../modules/strategy/entities/llm-proposal.entity";
import { Guess, GuessResult } from "../modules/strategy/entities/guess.entity";
import { Puzzle } from "../modules/game/entities/puzzle.entity";
import { computeInitialWordOrder } from "../modules/strategy/strategy-run-store.service";
import { buildInitialPrompt, buildRetryPrompt } from "../modules/strategy/llm-strategy-runner.service";
import { GROUP_SIZE } from "answer-grammar";

/**
 * One-off backfill for SolvePrompt rows written before PR1 of
 * docs/architecture/specs/08-persist-prompt-text.md added the promptText
 * column and made llm-strategy-runner.service.ts write it directly on every
 * new row (see that file's `transcriptText`). Historical rows written before
 * that deploy still have promptText: null — this reconstructs it for them by
 * replaying each run's state machine, the same way prompt-reconstruction.ts
 * used to do on every read (that module is deleted now that this backfill
 * and the runner's direct write cover every row; see git history for the
 * original if it's ever needed again).
 *
 * reconstructPromptTexts below is a port of prompt-reconstruction.ts's
 * reconstructSolvePrompts — same replay (walk a run's SolvePrompt rows in
 * call order, rebuild availableWords/lockedInGroups/lastFailedGuess from
 * each step's actually-submitted guesses, re-invoke buildInitialPrompt/
 * buildRetryPrompt, format with the same "[User]\n...\n\n[Assistant]\n..."
 * convention), just narrowed to return only the promptText per row instead
 * of the full read-model DTO (proposals/categoryEvaluation live untouched in
 * their own tables and don't need reconstructing). See
 * backfill-prompt-text.spec.ts (carried over from prompt-reconstruction's
 * own spec) for the fidelity bar this must hold — identical to
 * reconstruction's, just exercised once instead of on every read.
 *
 * Idempotent: only ever writes a row whose promptText is currently null, so
 * re-running it (e.g. to catch runs still in flight during the first pass —
 * see the design spec's Risks section) is always safe.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/backfill-prompt-text.ts
 *
 * Production/container:
 *   docker exec <container> npx tsx src/scripts/backfill-prompt-text.ts
 */

const logger = new Logger("BackfillPromptText");

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// Ported verbatim from prompt-reconstruction.ts's formatConversation.
export function formatConversation(turns: ConversationTurn[]): string {
  return turns
    .map((turn) => `[${turn.role === "user" ? "User" : "Assistant"}]\n${turn.content}`)
    .join("\n\n");
}

/**
 * Replays one run's SolvePrompt rows in call order and returns the exact
 * transcript text each row's attempt would have sent, keyed by SolvePrompt
 * id — see this file's top comment for how this relates to
 * prompt-reconstruction.ts's original reconstructSolvePrompts.
 */
export function reconstructPromptTexts(
  originalWords: string[],
  solvePrompts: SolvePrompt[],
  proposals: LlmProposal[],
  guessesById: Map<number, Guess>,
): Map<number, string> {
  const proposalsByPrompt = new Map<number, LlmProposal[]>();
  for (const proposal of proposals) {
    const list = proposalsByPrompt.get(proposal.solvePromptId) ?? [];
    list.push(proposal);
    proposalsByPrompt.set(proposal.solvePromptId, list);
  }

  // Multiple rows can share one promptNumber (a step's retried-then-
  // succeeded attempts, or a CALL_ERROR row alongside the step's later
  // success), so attemptNumber is a tiebreak keeping a step's own rows in
  // call order — mirrors reconstructSolvePrompts.
  const orderedPrompts = [...solvePrompts].sort(
    (a, b) => a.promptNumber - b.promptNumber || a.attemptNumber - b.attemptNumber,
  );

  let availableWords = [...originalWords];
  const lockedInGroups: string[][] = [];
  let lastFailedGuess: { items: string[]; result: string } | null = null;
  // Every earlier step's (user, assistant) turn pair, in order — mirrors the
  // live runner's own `messages` array. A CALL_ERROR row never got appended
  // to the live `messages` either (the runner pops the user turn back off on
  // a failed call), so only non-CALL_ERROR rows push onto this below.
  const history: ConversationTurn[] = [];

  const textByPromptId = new Map<number, string>();

  for (const prompt of orderedPrompts) {
    const isCallError = prompt.status === SolvePromptStatus.CALL_ERROR;
    const N = availableWords.length / GROUP_SIZE;

    // The live runner only ever builds a RETRY prompt when lastFailedGuess
    // is set (that's the branch condition), so the `lastFailedGuess` guard
    // below is purely defensive against stored data that doesn't match that
    // invariant — falls back to INITIAL rather than throwing.
    const currentPrompt =
      prompt.promptType === SolvePromptType.RETRY && lastFailedGuess
        ? buildRetryPrompt(availableWords, lockedInGroups, lastFailedGuess, N)
        : buildInitialPrompt(availableWords, N);

    textByPromptId.set(
      prompt.id,
      formatConversation([...history, { role: "user", content: currentPrompt }]),
    );

    // A CALL_ERROR row produced no assistant reply — folding a phantom
    // (user, empty-assistant) pair into history here would corrupt every
    // later step's reconstructed text for the rest of the run.
    if (!isCallError) {
      history.push({ role: "user", content: currentPrompt });
      history.push({ role: "assistant", content: prompt.rawResponseText ?? "" });
    }

    // Advance state using the proposals this step actually submitted as
    // guesses, in the order they were submitted — mirrors the runner's own
    // sequential evaluate-until-failure loop.
    const usedSteps = (proposalsByPrompt.get(prompt.id) ?? [])
      .slice()
      .sort((a, b) => a.id - b.id)
      .filter((proposal) => proposal.status === LlmProposalStatus.USED && proposal.guessId !== null)
      .map((proposal) => ({ words: proposal.words, guess: guessesById.get(proposal.guessId!) }))
      .filter((step): step is { words: string[]; guess: Guess } => step.guess !== undefined)
      .sort((a, b) => a.guess.sequenceNumber - b.guess.sequenceNumber);

    for (const step of usedSteps) {
      if (step.guess.result === GuessResult.SUCCESS) {
        availableWords = availableWords.filter((word) => !step.words.includes(word));
        lockedInGroups.push(step.words);
        lastFailedGuess = null;
      } else {
        const resultStr = step.guess.result === GuessResult.OFF_BY_ONE ? "one away" : "incorrect";
        lastFailedGuess = { items: step.words, result: resultStr };
      }
    }
  }

  return textByPromptId;
}

async function main() {
  // Dynamic import (not a static top-level one): AppModule's decorator
  // eagerly runs ConfigModule.forRoot()'s env-var validation the instant the
  // module is loaded, which would otherwise blow up importing this file at
  // all — including backfill-prompt-text.spec.ts importing this file's pure
  // exports without ever calling main(). Deferring the import to here means
  // it only loads when this script is actually run.
  const { AppModule } = await import("../app.module");
  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const dataSource = appContext.get(DataSource);
    const solvePromptRepo = dataSource.getRepository(SolvePrompt);
    const strategyRunRepo = dataSource.getRepository(StrategyRun);
    const llmProposalRepo = dataSource.getRepository(LlmProposal);
    const guessRepo = dataSource.getRepository(Guess);
    const puzzleRepo = dataSource.getRepository(Puzzle);

    const nullRows = await solvePromptRepo.find({
      where: { promptText: IsNull() },
      select: { id: true, strategyRunId: true },
    });
    logger.log(`Found ${nullRows.length} SolvePrompt row(s) with promptText still null.`);

    if (nullRows.length === 0) {
      return;
    }

    const strategyRunIds = [...new Set(nullRows.map((row) => row.strategyRunId))];
    const runs = await strategyRunRepo.find({
      where: { id: In(strategyRunIds) },
      select: { id: true, puzzleId: true, strategyName: true },
    });
    logger.log(`Spanning ${runs.length} run(s).`);

    const puzzleIds = [...new Set(runs.map((run) => run.puzzleId))];
    const puzzles = await puzzleRepo.find({
      where: { id: In(puzzleIds) },
      relations: { answerGroups: { members: true } },
    });
    const puzzleById = new Map(puzzles.map((puzzle) => [puzzle.id, puzzle]));

    let updatedCount = 0;
    let skippedRuns = 0;

    for (const run of runs) {
      const puzzle = puzzleById.get(run.puzzleId);
      if (!puzzle) {
        // Shouldn't happen (puzzleId is a foreign key) — skip defensively
        // rather than let one bad row crash the whole batch.
        logger.warn(`Run ${run.id}: puzzle ${run.puzzleId} not found, skipping.`);
        skippedRuns++;
        continue;
      }

      const [solvePrompts, proposals, guesses] = await Promise.all([
        solvePromptRepo.find({
          where: { strategyRunId: run.id },
          order: { promptNumber: "ASC", attemptNumber: "ASC" },
        }),
        llmProposalRepo.find({ where: { strategyRunId: run.id } }),
        guessRepo.find({
          where: { strategyRunId: run.id },
          select: { id: true, sequenceNumber: true, words: true, result: true },
        }),
      ]);

      const guessesById = new Map(guesses.map((guess) => [guess.id, guess]));
      const originalWords = computeInitialWordOrder(puzzle, run.strategyName);
      const textByPromptId = reconstructPromptTexts(originalWords, solvePrompts, proposals, guessesById);

      for (const prompt of solvePrompts) {
        // Already written by the runner (a straggler that landed after this
        // script's initial SELECT — PR1 guarantees new rows are never null)
        // or by a previous backfill pass — see this file's idempotency note.
        if (prompt.promptText !== null) {
          continue;
        }
        const text = textByPromptId.get(prompt.id);
        if (text === undefined) {
          logger.warn(`SolvePrompt ${prompt.id}: no reconstructed text produced, skipping.`);
          continue;
        }
        await solvePromptRepo.update(prompt.id, { promptText: text });
        updatedCount++;
      }
    }

    logger.log(`Updated ${updatedCount} of ${nullRows.length} row(s).`);
    if (skippedRuns > 0) {
      logger.warn(`Skipped ${skippedRuns} run(s) with no resolvable puzzle.`);
    }
  } finally {
    await appContext.close();
  }
}

// Only run when invoked directly (npx tsx / node), not when
// backfill-prompt-text.spec.ts imports this file's pure exports — importing
// it must never boot a Nest application context.
if (require.main === module) {
  // appContext.close() does not close the app's BullMQ queues (module-scope
  // singletons with no onModuleDestroy), so their ioredis connections keep
  // the event loop alive. Exit explicitly instead of relying on natural
  // exit.
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(error);
      process.exit(1);
    });
}
