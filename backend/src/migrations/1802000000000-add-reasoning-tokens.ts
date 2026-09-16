import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds a nullable reasoningTokens column to SolvePrompt and
 * CategoryEvaluation — the subset of completionTokens spent on the model's
 * internal reasoning (OpenAI's completion_tokens_details.reasoning_tokens /
 * the Responses API's output_tokens_details.reasoning_tokens). Additive
 * information only: never folded into totalTokens, never used in cap or
 * cost math (OpenAI already bills it as ordinary output tokens). Purely
 * additive here too — no backfill in this migration; a separate one-off
 * script (backfill-token-usage.ts) recovers it for historical rows from
 * their stored responseBody. See
 * docs/superpowers/plans/2026-09-16-free-tier-token-accounting.md.
 */
export class AddReasoningTokens1802000000000 implements MigrationInterface {
  name = "AddReasoningTokens1802000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" ADD COLUMN "reasoningTokens" INT
    `);
    await queryRunner.query(`
      ALTER TABLE "CategoryEvaluation" ADD COLUMN "reasoningTokens" INT
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt" DROP COLUMN "reasoningTokens"
    `);
    await queryRunner.query(`
      ALTER TABLE "CategoryEvaluation" DROP COLUMN "reasoningTokens"
    `);
  }
}
