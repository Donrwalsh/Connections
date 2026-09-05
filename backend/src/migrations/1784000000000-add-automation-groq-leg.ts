import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds the groqBurn leg's outcome/message columns to AutomationRunLog —
 * the Groq counterpart to the existing googleBurnOutcome/googleBurnMessage
 * columns from 1778000000000-add-automation-run-log.ts. */
export class AddAutomationGroqLeg1784000000000 implements MigrationInterface {
  name = "AddAutomationGroqLeg1784000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        ADD COLUMN IF NOT EXISTS "groqBurnOutcome" VARCHAR,
        ADD COLUMN IF NOT EXISTS "groqBurnMessage" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        DROP COLUMN IF EXISTS "groqBurnOutcome",
        DROP COLUMN IF EXISTS "groqBurnMessage"
    `);
  }
}
