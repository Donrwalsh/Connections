import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { DataSource, IsNull } from "typeorm";
import { SolvePrompt } from "../modules/strategy/entities/solve-prompt.entity";
import { CategoryEvaluation } from "../modules/strategy/entities/category-evaluation.entity";

/**
 * One-off backfill for SolvePrompt and CategoryEvaluation rows whose
 * promptTokens/completionTokens/totalTokens/reasoningTokens are null but
 * whose responseBody (raw jsonb, always captured regardless of outcome —
 * see toJsonbResponseBody on both writers) still has the usage data OpenAI
 * actually returned. Recovers both known raw shapes:
 *
 *  - OpenAI Responses API: input_tokens / output_tokens / total_tokens /
 *    output_tokens_details.reasoning_tokens
 *  - OpenAI Chat Completions: prompt_tokens / completion_tokens /
 *    total_tokens / completion_tokens_details.reasoning_tokens
 *
 * Covers every row with recoverable data, not just callError rows — a
 * successful row written before the reasoningTokens column existed has the
 * same gap for that one field, and this backfill is what makes historical
 * runs display correctly in the new per-step reasoning-token UI.
 *
 * Idempotent at the row level: a row is only touched when it currently has
 * at least one null token column; once touched, all four columns are
 * recomputed from responseBody and rewritten together (not gated
 * per-column). That's safe here — not merely re-running without harm, but
 * actually a no-op in every normal case — because both the live capture
 * path and this backfill derive their values from the exact same raw
 * responseBody JSON, so a re-run always recomputes byte-identical values
 * for columns that were already correct.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/backfill-token-usage.ts --dry-run
 *   npx tsx src/scripts/backfill-token-usage.ts
 *
 * Production/container:
 *   docker exec <container> node dist/scripts/backfill-token-usage.js --dry-run
 *   docker exec <container> node dist/scripts/backfill-token-usage.js
 */

const logger = new Logger("BackfillTokenUsage");

export interface ParsedUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
}

/**
 * Extracts token counts from a stored responseBody, trying both known raw
 * OpenAI shapes. Returns null when responseBody isn't a usage-bearing
 * object at all (a gateway HTML error page, a plain string, absent usage).
 * reasoningTokens is null (not 0) when the shape has no reasoning
 * breakdown, distinguishing "not a reasoning-capable call" from "zero
 * reasoning tokens spent".
 */
export function parseUsageFromResponseBody(responseBody: unknown): ParsedUsage | null {
  if (typeof responseBody !== "object" || responseBody === null) return null;
  const usage = (responseBody as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;

  const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

  // Responses API shape.
  if ("input_tokens" in u || "output_tokens" in u) {
    const details = u.output_tokens_details as Record<string, unknown> | undefined;
    return {
      promptTokens: asNumber(u.input_tokens),
      completionTokens: asNumber(u.output_tokens),
      totalTokens: asNumber(u.total_tokens),
      reasoningTokens: details ? asNumber(details.reasoning_tokens) : null,
    };
  }

  // Chat Completions shape.
  if ("prompt_tokens" in u || "completion_tokens" in u) {
    const details = u.completion_tokens_details as Record<string, unknown> | undefined;
    return {
      promptTokens: asNumber(u.prompt_tokens),
      completionTokens: asNumber(u.completion_tokens),
      totalTokens: asNumber(u.total_tokens),
      reasoningTokens: details ? asNumber(details.reasoning_tokens) : null,
    };
  }

  return null;
}

async function backfillTable<T extends { id: number; responseBody: unknown }>(
  dataSource: DataSource,
  entity: new () => T,
  label: string,
  dryRun: boolean,
): Promise<void> {
  const repo = dataSource.getRepository(entity);
  const rows = await repo.find({
    where: [
      { promptTokens: IsNull() } as never,
      { completionTokens: IsNull() } as never,
      { totalTokens: IsNull() } as never,
      { reasoningTokens: IsNull() } as never,
    ],
    select: { id: true, responseBody: true } as never,
  });
  logger.log(`[${label}] Found ${rows.length} row(s) with at least one null token column.`);

  let updatedCount = 0;
  for (const row of rows) {
    const parsed = parseUsageFromResponseBody(row.responseBody);
    if (!parsed) continue;

    if (dryRun) {
      updatedCount++;
      continue;
    }

    await repo.update(row.id, {
      promptTokens: parsed.promptTokens,
      completionTokens: parsed.completionTokens,
      totalTokens: parsed.totalTokens,
      reasoningTokens: parsed.reasoningTokens,
    } as never);
    updatedCount++;
  }

  logger.log(
    `[${label}] ${dryRun ? "Would update" : "Updated"} ${updatedCount} of ${rows.length} row(s).`,
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    logger.log("Running in --dry-run mode: no writes will be made.");
  }

  // Dynamic import (not a static top-level one): AppModule's decorator
  // eagerly runs ConfigModule.forRoot()'s env-var validation the instant the
  // module is loaded, which would otherwise blow up importing this file at
  // all — including backfill-token-usage.spec.ts importing this file's pure
  // parseUsageFromResponseBody export without ever calling main(). Deferring
  // the import to here means it only loads when this script is actually run
  // (same reasoning as backfill-prompt-text.ts).
  const { AppModule } = await import("../app.module");
  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const dataSource = appContext.get(DataSource);
    await backfillTable(dataSource, SolvePrompt, "SolvePrompt", dryRun);
    await backfillTable(dataSource, CategoryEvaluation, "CategoryEvaluation", dryRun);
  } finally {
    await appContext.close();
  }
}

// Only run when invoked directly (npx tsx / node), not when
// backfill-token-usage.spec.ts imports this file's pure exports — importing
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
