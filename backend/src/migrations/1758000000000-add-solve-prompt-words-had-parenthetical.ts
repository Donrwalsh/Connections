import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Flags SolvePrompt rows whose "Words:" line needed a trailing parenthetical
 * explanation stripped before it would parse as 4 clean words (see
 * llm-strategy-runner.service.ts). Defaults false for every existing row —
 * there's no way to retroactively detect this from already-stored data
 * without re-parsing rawResponseText, which is out of scope here.
 */
export class AddSolvePromptWordsHadParenthetical1758000000000 implements MigrationInterface {
  name = "AddSolvePromptWordsHadParenthetical1758000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      ADD COLUMN "wordsHadParenthetical" BOOLEAN NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "SolvePrompt" DROP COLUMN "wordsHadParenthetical"`);
  }
}
