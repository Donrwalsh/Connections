import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds the openRouterBurn leg's outcome/message columns to
 * AutomationRunLog — the OpenRouter counterpart to
 * groqBurnOutcome/groqBurnMessage. */
export class AddAutomationOpenRouterLeg1791000000000 implements MigrationInterface {
  name = "AddAutomationOpenRouterLeg1791000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        ADD COLUMN IF NOT EXISTS "openRouterBurnOutcome" VARCHAR,
        ADD COLUMN IF NOT EXISTS "openRouterBurnMessage" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        DROP COLUMN IF EXISTS "openRouterBurnOutcome",
        DROP COLUMN IF EXISTS "openRouterBurnMessage"
    `);
  }
}
