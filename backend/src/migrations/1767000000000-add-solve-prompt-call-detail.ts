import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds raw OpenAI call-detail columns to SolvePrompt and a new CALL_ERROR
 * status, so a strategy-run OpenAI call that fails (or gets retried and
 * fails before eventually succeeding) leaves a row instead of vanishing —
 * see docs/superpowers/specs/2026-08-21-openai-call-logging-design.md.
 */
export class AddSolvePromptCallDetail1767000000000 implements MigrationInterface {
  name = "AddSolvePromptCallDetail1767000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "solve_prompt_status_enum" ADD VALUE 'callError'`);

    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      ADD COLUMN "attemptNumber" INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN "requestBody" JSONB,
      ADD COLUMN "responseId" TEXT,
      ADD COLUMN "responseHeaders" JSONB,
      ADD COLUMN "responseBody" JSONB,
      ADD COLUMN "statusCode" INTEGER,
      ADD COLUMN "errorName" TEXT,
      ADD COLUMN "errorMessage" TEXT,
      ADD COLUMN "isRetryable" BOOLEAN
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      DROP COLUMN "attemptNumber",
      DROP COLUMN "requestBody",
      DROP COLUMN "responseId",
      DROP COLUMN "responseHeaders",
      DROP COLUMN "responseBody",
      DROP COLUMN "statusCode",
      DROP COLUMN "errorName",
      DROP COLUMN "errorMessage",
      DROP COLUMN "isRetryable"
    `);
    // Postgres has no "remove enum value" operation short of recreating the
    // type (rename it, create a replacement without the value, repoint the
    // column, drop the old type) — this migration doesn't attempt that.
    // Rolling back leaves 'callError' a valid-but-unused status value,
    // which is harmless.
  }
}
