import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { SolvePrompt, SolvePromptStatus } from "../modules/strategy/entities/solve-prompt.entity";
import { StrategyRun } from "../modules/strategy/entities/strategy-run.entity";

/**
 * Read-only audit for a second, narrower bug in the same manual-retry
 * feature trim-resume-corrupted-runs.ts repairs: LlmStrategyRunner's
 * reconstructMessages (llm-strategy-runner.service.ts) rebuilds a resumed
 * run's conversation history from the last SolvePrompt row's `requestBody`.
 * That row is always the CALL_ERROR row that put the run into 'error' in the
 * first place (the only status transition that makes it eligible for
 * StrategyDispatch.retryRun). But OrchestratorService.executeCall's `catch`
 * block — hit for a client-side failure (timeout, ECONNRESET, DNS failure —
 * anything that never got a response back from the orchestrator to read
 * detail from) — never populated `error.requestBody` before the fix
 * alongside this script (see orchestrator.service.ts). So for every run
 * whose terminal failure was that kind of error rather than an HTTP error
 * response from the orchestrator, `requestBody` on that row is NULL, and
 * reconstructMessages silently fell back to an empty history: the manual
 * retry's first prompt went out as a fresh conversation with none of the
 * run's real prior turns, even though its promptType/game state (rebuilt
 * separately, from Guess rows) still came out correct.
 *
 * That's a strictly narrower symptom than trim-resume-corrupted-runs.ts's
 * corruption (promptType/lockedInGroups there were wrong too, and guesses
 * after the point of corruption are untrustworthy) — here every guess is
 * still the model's genuine attempt, just made with less conversational
 * context than intended. There is nothing to repair: the true prior
 * requestBody was never captured, so it can't be reconstructed after the
 * fact. This script only reports which runs hit it, so they can be judged
 * (or excluded from benchmark comparisons) with that in mind.
 *
 * findManualRetryHistoryLoss below is the pure per-run detector: unit-tested
 * in find-manual-retry-history-loss.spec.ts.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/find-manual-retry-history-loss.ts
 *   npx tsx src/scripts/find-manual-retry-history-loss.ts --run-id=1234
 *
 * Production/container:
 *   docker exec <container> npm run find:manual-retry-history-loss
 */

const logger = new Logger("FindManualRetryHistoryLoss");

export interface ManualRetryHistoryLoss {
  // The CALL_ERROR row whose requestBody reconstructMessages needed and
  // didn't have.
  triggerPromptNumber: number;
  // The first manualRetry row sent after it — the one that went out with an
  // empty conversation history instead of the run's real prior turns.
  retryPromptNumber: number;
}

/** True for a requestBody shaped either way reconstructMessages
 * (llm-strategy-runner.service.ts) can use it: a non-empty ChatMessage[]
 * under `.messages` (every non-OpenAI provider, and the backend->
 * orchestrator payload OrchestratorService.executeCall falls back to on a
 * client-side failure), or a non-empty Responses-API `.input` array (the
 * shape `@ai-sdk/openai`'s default `openai(modelId)` factory always uses —
 * see orchestrator/src/answer-step.ts's `result.request.body`). Mirrors
 * that method's own isChatMessageArray/isResponsesApiInputArray checks
 * exactly — this script must flag precisely the rows that method actually
 * fell back to `[]` for, nothing more and nothing less. */
function hasReconstructableHistory(requestBody: unknown): boolean {
  const body = requestBody as { messages?: unknown; input?: unknown } | null;

  const messages = body?.messages;
  if (Array.isArray(messages) && messages.length > 0 && messages.every(isChatMessage)) {
    return true;
  }

  const input = body?.input;
  return Array.isArray(input) && input.length > 0 && input.every(isResponsesApiInputItem);
}

function isChatMessage(m: unknown): boolean {
  return (
    typeof m === "object" &&
    m !== null &&
    ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") &&
    typeof (m as { content?: unknown }).content === "string"
  );
}

function isResponsesApiInputItem(item: unknown): boolean {
  return (
    typeof item === "object" &&
    item !== null &&
    ((item as { role?: unknown }).role === "user" || (item as { role?: unknown }).role === "assistant") &&
    Array.isArray((item as { content?: unknown }).content) &&
    (item as { content: unknown[] }).content.every(
      (part) => typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string",
    )
  );
}

/**
 * Detects the history-loss signature on one run's SolvePrompt rows (any
 * order). Returns null for a run with no manual retry, or one whose retry's
 * trigger row either had nothing real to lose (no earlier successful call —
 * every prior attempt, if any, failed and its own turn was popped from
 * history the same way live runs do) or did capture a usable requestBody.
 */
export function findManualRetryHistoryLoss(
  solvePrompts: Pick<SolvePrompt, "promptNumber" | "status" | "manualRetry" | "requestBody">[],
): ManualRetryHistoryLoss | null {
  const ordered = [...solvePrompts].sort((a, b) => a.promptNumber - b.promptNumber);

  const firstRetry = ordered.find((p) => p.manualRetry);
  if (!firstRetry) return null;

  const trigger = ordered.find((p) => p.promptNumber === firstRetry.promptNumber - 1);
  if (!trigger) return null;

  // Only a prior *successful* call leaves a surviving turn in the
  // conversation history that reconstruction could have carried forward —
  // every prior CALL_ERROR call's own user turn was popped the same way
  // llm-strategy-runner.service.ts's live run loop pops it, so a run with no
  // earlier PARSED row genuinely had nothing to lose even had the trigger
  // row's requestBody been captured.
  const hadRealHistoryToLose = ordered.some(
    (p) => p.promptNumber < trigger.promptNumber && p.status === SolvePromptStatus.PARSED,
  );
  if (!hadRealHistoryToLose) return null;

  if (hasReconstructableHistory(trigger.requestBody)) return null;

  return { triggerPromptNumber: trigger.promptNumber, retryPromptNumber: firstRetry.promptNumber };
}

function parseArgs(argv: string[]) {
  const runIdArg = argv.find((a) => a.startsWith("--run-id="));
  const runId = runIdArg ? Number(runIdArg.slice("--run-id=".length)) : undefined;
  return { runId };
}

async function main() {
  const { runId } = parseArgs(process.argv.slice(2));

  // Dynamic import — see backfill-prompt-text.ts's identical comment: loading
  // AppModule eagerly runs env-var validation, which must not happen just by
  // importing this file's pure exports (e.g. from this script's spec).
  const { AppModule } = await import("../app.module");
  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const dataSource = appContext.get(DataSource);
    const solvePromptRepo = dataSource.getRepository(SolvePrompt);
    const strategyRunRepo = dataSource.getRepository(StrategyRun);

    const runIdsWithManualRetry = await solvePromptRepo
      .createQueryBuilder("prompt")
      .select('DISTINCT prompt."strategyRunId"', "strategyRunId")
      .where('prompt."manualRetry" = true')
      .getRawMany<{ strategyRunId: number }>();
    const candidateRunIds = runIdsWithManualRetry
      .map((row) => row.strategyRunId)
      .filter((id) => runId === undefined || id === runId);

    logger.log(`Scanning ${candidateRunIds.length} manually-retried run(s).`);

    if (candidateRunIds.length === 0) {
      return;
    }

    const runs = await strategyRunRepo.find({
      where: { id: In(candidateRunIds) },
      select: { id: true, puzzleId: true, strategyName: true, modelName: true, trialNumber: true, status: true },
    });
    const runById = new Map(runs.map((run) => [run.id, run]));

    let affectedCount = 0;

    for (const strategyRunId of candidateRunIds) {
      const solvePrompts = await solvePromptRepo.find({
        where: { strategyRunId },
        select: { promptNumber: true, status: true, manualRetry: true, requestBody: true },
      });

      const loss = findManualRetryHistoryLoss(solvePrompts);
      if (!loss) continue;

      affectedCount++;
      const run = runById.get(strategyRunId);
      logger.log(
        `Run ${strategyRunId}${run ? ` (puzzle ${run.puzzleId}, ${run.strategyName}${run.modelName ? `/${run.modelName}` : ""}, trial ${run.trialNumber}, currently ${run.status})` : ""}: ` +
          `manual retry at promptNumber ${loss.retryPromptNumber} lost the conversation history a real prior turn (through promptNumber ${loss.triggerPromptNumber}) should have carried forward — it went out as a fresh conversation instead.`,
      );
    }

    logger.log(`${affectedCount} of ${candidateRunIds.length} manually-retried run(s) affected.`);
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
