import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds SolvePrompt.manualRetry — see solve-prompt.entity.ts for what it
 * means and why it's a separate column from promptType.
 */
export class AddSolvePromptManualRetry1802000000000 implements MigrationInterface {
  name = "AddSolvePromptManualRetry1802000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      ADD COLUMN "manualRetry" BOOLEAN NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      DROP COLUMN "manualRetry"
    `);
  }
}
