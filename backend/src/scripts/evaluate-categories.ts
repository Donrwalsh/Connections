import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "../app.module";
import { CategoryEvaluatorService } from "../modules/strategy/category-evaluator.service";

/**
 * Enqueues LLM-judge category-evaluation jobs for the most recent
 * successful LLM guesses that have no CategoryEvaluation row yet. The
 * worker (llm-<provider>-runs queue) does the actual judging — this only
 * queues the work, the same as POST /dispatch/evaluate-categories.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/evaluate-categories.ts --limit 100
 *
 * --force re-enqueues even already-evaluated proposals (the job passes
 * force through to evaluateProposal, which then overwrites the row).
 *
 * Production/container:
 *   docker exec <container> npx tsx src/scripts/evaluate-categories.ts --limit 200
 */

const logger = new Logger("EvaluateCategories");

function parseArgs(argv: string[]): { limit?: number; force: boolean } {
  const force = argv.includes("--force");
  const i = argv.indexOf("--limit");
  const limit = i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : undefined;
  return { limit, force };
}

async function main() {
  const { limit, force } = parseArgs(process.argv.slice(2));
  const appContext = await NestFactory.createApplicationContext(AppModule);
  try {
    const service = appContext.get(CategoryEvaluatorService);
    const result = await service.enqueuePending({ limit, force });
    logger.log(`Enqueued ${result.enqueued} job(s): ${result.llmProposalIds.join(", ") || "(none)"}`);
  } finally {
    await appContext.close();
  }
}

// See backfill-issue-tags.ts — appContext.close() doesn't close the BullMQ
// queues' ioredis connections, so exit explicitly.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error);
    process.exit(1);
  });
