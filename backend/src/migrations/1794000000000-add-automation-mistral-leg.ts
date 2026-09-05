import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds the mistralBurn leg's outcome/message columns to AutomationRunLog —
 * the Mistral counterpart to the existing groqBurnOutcome/groqBurnMessage
 * columns from 1784000000000-add-automation-groq-leg.ts. */
export class AddAutomationMistralLeg1794000000000 implements MigrationInterface {
  name = "AddAutomationMistralLeg1794000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        ADD COLUMN IF NOT EXISTS "mistralBurnOutcome" VARCHAR,
        ADD COLUMN IF NOT EXISTS "mistralBurnMessage" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        DROP COLUMN IF EXISTS "mistralBurnOutcome",
        DROP COLUMN IF EXISTS "mistralBurnMessage"
    `);
  }
}
