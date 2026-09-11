import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds a nullable promptText column to SolvePrompt so the runner
 * (llm-strategy-runner.service.ts) can persist the exact [User]/[Assistant]
 * transcript it sent for each attempt directly, instead of that text only
 * ever being reconstructible after the fact by replaying run state (see
 * prompt-reconstruction.ts) — see
 * docs/architecture/specs/08-persist-prompt-text.md. Purely additive: no
 * backfill here (existing rows keep promptText null; a separate one-time
 * script handles backfilling them), and nothing reads this column yet.
 */
export class AddSolvePromptText1801000000000 implements MigrationInterface {
  name = "AddSolvePromptText1801000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" ADD COLUMN "promptText" TEXT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" DROP COLUMN "promptText"
    `);
  }
}
