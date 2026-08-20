import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "../app.module";
import { PuzzleIngestionService } from "../modules/game/puzzle-ingestion.service";

/**
 * One-off backfill for the historical dates that were previously skipped by
 * the old AWKWARD_DATES allowlist in PuzzleIngestionService, before shape
 * detection replaced it. Run once after deploying image-puzzle support:
 *
 *   npx tsx src/scripts/backfill-image-puzzle-dates.ts
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

async function main() {
  const logger = new Logger("BackfillImagePuzzleDates");
  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const puzzleIngestionService = appContext.get(PuzzleIngestionService);
    const result = await puzzleIngestionService.ingestSpecificDates(HISTORICAL_IMAGE_DATES);
    logger.log(`Backfill result: ${JSON.stringify(result)}`);
  } finally {
    await appContext.close();
  }
}

main();
