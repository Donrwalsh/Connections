import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds the sambaNovaBurn leg's outcome/message columns to AutomationRunLog
 * — the SambaNova counterpart to the existing
 * mistralBurnOutcome/mistralBurnMessage columns. */
export class AddAutomationSambaNovaLeg1799000000000 implements MigrationInterface {
  name = "AddAutomationSambaNovaLeg1799000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        ADD COLUMN IF NOT EXISTS "sambaNovaBurnOutcome" VARCHAR,
        ADD COLUMN IF NOT EXISTS "sambaNovaBurnMessage" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        DROP COLUMN IF EXISTS "sambaNovaBurnOutcome",
        DROP COLUMN IF EXISTS "sambaNovaBurnMessage"
    `);
  }
}
