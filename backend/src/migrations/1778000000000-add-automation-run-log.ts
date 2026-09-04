import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * One row per UTC calendar day, upserted as each leg of the daily
 * free-tier-automation chain (DailyAutomationService) reports its outcome —
 * the source of truth the UI reads for "did today's automatic run happen,
 * and what did it do". See
 * docs/superpowers/specs/2026-09-04-daily-free-tier-automation-design.md.
 */
export class AddAutomationRunLog1778000000000 implements MigrationInterface {
  name = "AddAutomationRunLog1778000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "AutomationRunLog" (
        "date" VARCHAR PRIMARY KEY,
        "triggeredAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "judgeEnqueued" INT,
        "judgeError" TEXT,
        "miniBurnOutcome" VARCHAR,
        "miniBurnMessage" TEXT,
        "googleBurnOutcome" VARCHAR,
        "googleBurnMessage" TEXT,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "AutomationRunLog"`);
  }
}
