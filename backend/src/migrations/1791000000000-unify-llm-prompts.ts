import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Unifies LLM prompts to match the AI Assist flow:
 * - Adds llmDetails (JSONB) to LlmProposal
 * - Removes category, confidence from LlmProposal
 * - Removes numResponses, promptAttempts, duplicatesRejected, llmDetails from Guess
 * - Removes triggeredByGuessId from SolvePrompt
 */
export class UnifyLlmPrompts1791000000000 implements MigrationInterface {
  name = "UnifyLlmPrompts1791000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add llmDetails to LlmProposal
    await queryRunner.query(
      `ALTER TABLE "LlmProposal" ADD COLUMN IF NOT EXISTS "llmDetails" JSONB NULL`,
    );

    // Remove category and confidence from LlmProposal
    await queryRunner.query(
      `ALTER TABLE "LlmProposal" DROP COLUMN IF EXISTS "category"`,
    );
    await queryRunner.query(
      `ALTER TABLE "LlmProposal" DROP COLUMN IF EXISTS "confidence"`,
    );

    // Rename guessNumber → promptNumber on LlmProposal
    await queryRunner.query(
      `ALTER TABLE "LlmProposal" RENAME COLUMN "guessNumber" TO "promptNumber"`,
    );

    // Remove columns from Guess
    await queryRunner.query(
      `ALTER TABLE "Guess" DROP COLUMN IF EXISTS "numResponses"`,
    );
    await queryRunner.query(
      `ALTER TABLE "Guess" DROP COLUMN IF EXISTS "promptAttempts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "Guess" DROP COLUMN IF EXISTS "duplicatesRejected"`,
    );
    await queryRunner.query(
      `ALTER TABLE "Guess" DROP COLUMN IF EXISTS "llmDetails"`,
    );

    // Remove triggeredByGuessId from SolvePrompt
    await queryRunner.query(
      `ALTER TABLE "SolvePrompt" DROP COLUMN IF EXISTS "triggeredByGuessId"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore SolvePrompt.triggeredByGuessId
    await queryRunner.query(
      `ALTER TABLE "SolvePrompt" ADD COLUMN IF NOT EXISTS "triggeredByGuessId" INT NULL`,
    );
    await queryRunner.query(
      `DO $$ BEGIN
        ALTER TABLE "SolvePrompt"
          ADD CONSTRAINT "FK_SolvePrompt_triggeredByGuessId"
          FOREIGN KEY ("triggeredByGuessId") REFERENCES "Guess"("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );

    // Restore Guess columns
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "llmDetails" JSONB NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "duplicatesRejected" INT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "promptAttempts" INT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "numResponses" INT NULL`,
    );

    // Rename promptNumber back to guessNumber
    await queryRunner.query(
      `ALTER TABLE "LlmProposal" RENAME COLUMN "promptNumber" TO "guessNumber"`,
    );

    // Restore LlmProposal columns
    await queryRunner.query(
      `ALTER TABLE "LlmProposal" ADD COLUMN IF NOT EXISTS "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "LlmProposal" ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT ''`,
    );

    // Drop the new llmDetails column
    await queryRunner.query(
      `ALTER TABLE "LlmProposal" DROP COLUMN IF EXISTS "llmDetails"`,
    );
  }
}
