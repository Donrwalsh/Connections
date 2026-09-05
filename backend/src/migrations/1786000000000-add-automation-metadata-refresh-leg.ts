import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds the metadata-refresh leg's outcome columns to AutomationRunLog —
 * this leg now runs first in DailyAutomationService.run(), refreshing
 * SupportedModel's OpenRouter-sourced metadata/pricing in-process before any
 * dispatch leg runs, so "metadata refresh happens before automated
 * dispatch" is a real guarantee rather than two independent cron schedules
 * racing. Same shape as the judgeEnqueued/judgeError columns from
 * 1778000000000-add-automation-run-log.ts. */
export class AddAutomationMetadataRefreshLeg1786000000000 implements MigrationInterface {
  name = "AddAutomationMetadataRefreshLeg1786000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        ADD COLUMN IF NOT EXISTS "metadataRefreshUpdated" INT,
        ADD COLUMN IF NOT EXISTS "metadataRefreshError" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        DROP COLUMN IF EXISTS "metadataRefreshUpdated",
        DROP COLUMN IF EXISTS "metadataRefreshError"
    `);
  }
}
