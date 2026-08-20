import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "../app.module";
import { PuzzleIngestionService } from "../modules/game/puzzle-ingestion.service";

/**
 * One-off backfill for the historical dates that were previously skipped by
 * the old AWKWARD_DATES allowlist in PuzzleIngestionService, before shape
 * detection replaced it. Run once after deploying image-puzzle support.
 *
 * Local dev (from backend/):
 *   npx tsx src/scripts/backfill-image-puzzle-dates.ts
 *
 * Production/container (after `npm run build`):
 *   npm run backfill:image-dates
 *   docker exec <container> npm run backfill:image-dates
 */
const HISTORICAL_IMAGE_DATES = [
  "2024-12-12",
  "2025-04-01",
  "2025-10-31",
  "2026-02-07",
  "2026-03-07",
  "2026-04-01",
  "2026-05-06",
];

const logger = new Logger("BackfillImagePuzzleDates");

async function main() {
  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const puzzleIngestionService = appContext.get(PuzzleIngestionService);
    const result = await puzzleIngestionService.ingestSpecificDates(HISTORICAL_IMAGE_DATES);
    logger.log(`Backfill result: ${JSON.stringify(result)}`);
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
