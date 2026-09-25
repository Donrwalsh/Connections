import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds the flagshipBurn leg's outcome/message columns to AutomationRunLog
 * — the OpenAI flagship counterpart to the existing
 * miniBurnOutcome/miniBurnMessage columns. */
export class AddAutomationFlagshipLeg1803000000000 implements MigrationInterface {
  name = "AddAutomationFlagshipLeg1803000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        ADD COLUMN IF NOT EXISTS "flagshipBurnOutcome" VARCHAR,
        ADD COLUMN IF NOT EXISTS "flagshipBurnMessage" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "AutomationRunLog"
        DROP COLUMN IF EXISTS "flagshipBurnOutcome",
        DROP COLUMN IF EXISTS "flagshipBurnMessage"
    `);
  }
}
