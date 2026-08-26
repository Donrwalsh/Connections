import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Replaces SolvePrompt.wordsHadParenthetical (a single boolean flag) with an
 * open-ended issueTags text[] column, so new model-response issue types
 * (group count off, hallucinated word, and an "unclassified" catch-all for
 * failure varieties not yet named) can be recorded without a schema
 * migration each time — see
 * docs/superpowers/specs/2026-08-26-llm-failure-taxonomy-design.md.
 */
export class AddSolvePromptIssueTags1774000000000 implements MigrationInterface {
  name = "AddSolvePromptIssueTags1774000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" ADD COLUMN "issueTags" TEXT[] NOT NULL DEFAULT '{}'
    `);
    await queryRunner.query(`
      UPDATE "SolvePrompt" SET "issueTags" = ARRAY['parentheticalStripped']
      WHERE "wordsHadParenthetical" = true
    `);
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" DROP COLUMN "wordsHadParenthetical"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" ADD COLUMN "wordsHadParenthetical" BOOLEAN NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      UPDATE "SolvePrompt" SET "wordsHadParenthetical" = true
      WHERE 'parentheticalStripped' = ANY("issueTags")
    `);
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" DROP COLUMN "issueTags"
    `);
    // The SolvePromptStatus TS enum's MALFORMED_GROUP_COUNT/MALFORMED_OTHER
    // values are removed from the entity in this same change, but — per the
    // existing precedent in 1767000000000-add-solve-prompt-call-detail.ts —
    // this migration doesn't attempt to remove them from the Postgres
    // "solve_prompt_status_enum" type itself (that requires recreating the
    // type: rename it, create a replacement without the value, repoint the
    // column, drop the old type). Leaving them as valid-but-unreferenced
    // values in the DB enum is harmless.
  }
}
