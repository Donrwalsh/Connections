import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the Groq burn leg's outcome columns to AutomationRunLog —
 * mirrors the existing googleBurnOutcome/googleBurnMessage pair.
 */
export class AddAutomationGroqLeg1786000000000 implements MigrationInterface {
  name = "AddAutomationGroqLeg1786000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "AutomationRunLog" ADD COLUMN "groqBurnOutcome" VARCHAR`);
    await queryRunner.query(`ALTER TABLE "AutomationRunLog" ADD COLUMN "groqBurnMessage" TEXT`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "AutomationRunLog" DROP COLUMN "groqBurnMessage"`);
    await queryRunner.query(`ALTER TABLE "AutomationRunLog" DROP COLUMN "groqBurnOutcome"`);
  }
}
