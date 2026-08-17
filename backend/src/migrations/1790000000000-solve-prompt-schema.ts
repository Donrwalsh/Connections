import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the SolvePrompt table for per-prompt multi-guess LLM solving, adjusts
 * LlmProposal to reference SolvePrompt instead of a bare promptNumber, drops
 * per-guess telemetry columns from Guess (they now live on SolvePrompt), and
 * extends the llm_proposal_status_enum with two new values.
 *
 * Idempotent where safe (enum creation, table creation). The LlmProposal
 * alteration is NOT idempotent — it will fail if the table already has rows
 * with the old promptNumber column and no solvePromptId, which is the correct
 * behavior: the migration must not silently drop data.
 */
export class SolvePrompt1790000000000 implements MigrationInterface {
  name = "SolvePrompt1790000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. New enums ──────────────────────────────────────────────────

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE solve_prompt_type_enum AS ENUM ('initialSolve', 'retry');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE solve_prompt_status_enum AS ENUM (
          'parsed', 'malformedNoAnswerBlock', 'malformedGroupCount', 'malformedOther'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // ── 2. Extend llm_proposal_status_enum ────────────────────────────
    // ALTER TYPE ... ADD VALUE IF NOT EXISTS is safe inside a transaction
    // on Postgres ≥ 9.1.

    await queryRunner.query(
      `ALTER TYPE llm_proposal_status_enum ADD VALUE IF NOT EXISTS 'supersededByRetry'`,
    );
    await queryRunner.query(
      `ALTER TYPE llm_proposal_status_enum ADD VALUE IF NOT EXISTS 'invalidItems'`,
    );

    // ── 3. Create SolvePrompt table ───────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "SolvePrompt" (
        "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "strategyRunId" INT NOT NULL
          REFERENCES "StrategyRun"("id") ON DELETE CASCADE,
        "promptNumber" INT NOT NULL,
        "promptType" solve_prompt_type_enum NOT NULL,
        "status" solve_prompt_status_enum NOT NULL DEFAULT 'parsed',
        "triggeredByGuessId" INT NULL
          REFERENCES "Guess"("id") ON DELETE SET NULL,
        "rawResponseText" TEXT NULL,
        "promptTokens" INT NULL,
        "completionTokens" INT NULL,
        "totalTokens" INT NULL,
        "latencyMs" INT NULL,
        "temperature" DOUBLE PRECISION NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "UQ_SolvePrompt_run_promptNumber"
          UNIQUE ("strategyRunId", "promptNumber")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SolvePrompt_strategyRunId"
        ON "SolvePrompt" ("strategyRunId")`,
    );

    // ── 4. Alter LlmProposal: drop promptNumber, add solvePromptId ────
    //
    // This table may or may not have existing rows depending on the
    // environment.  If rows exist, we must NOT silently drop the promptNumber
    // column without migrating the data — so the ALTER COLUMN DROP NOT NULL
    // + DROP COLUMN path is intentionally omitted.  Instead, we fail loudly
    // if any rows are present and the old column still exists.

    const hasPromptNumberCol = await queryRunner.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'LlmProposal'
        AND column_name = 'promptNumber'
      LIMIT 1
    `);

    if (hasPromptNumberCol.length > 0) {
      // If there are existing rows, stop — they would need a manual backfill.
      const rowCount = await queryRunner.query(`SELECT count(*) AS cnt FROM "LlmProposal"`);
      if (Number(rowCount[0].cnt) > 0) {
        throw new Error(
          "SolvePrompt migration: LlmProposal has existing rows with the old " +
            "promptNumber column.  Backfill solvePromptId manually before " +
            "running this migration, or truncate the table if the data is " +
            "discardable.",
        );
      }

      // Safe to drop — table is empty.
      await queryRunner.query(`ALTER TABLE "LlmProposal" DROP COLUMN "promptNumber"`);
    }

    // Add the new solvePromptId column.  Use IF NOT EXISTS so the migration
    // is safe to re-run on databases where a prior partial run already added
    // the column.
    const hasSolvePromptIdCol = await queryRunner.query(`
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'LlmProposal'
        AND column_name = 'solvePromptId'
      LIMIT 1
    `);

    if (hasSolvePromptIdCol.length === 0) {
      await queryRunner.query(`
        ALTER TABLE "LlmProposal"
          ADD COLUMN "solvePromptId" INT NOT NULL
          REFERENCES "SolvePrompt"("id") ON DELETE CASCADE
      `);
      await queryRunner.query(
        `CREATE INDEX "IDX_LlmProposal_solvePromptId"
          ON "LlmProposal" ("solvePromptId")`,
      );
    }

    // ── 5. Alter Guess: drop per-guess telemetry columns ──────────────
    // These now live on SolvePrompt.

    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "promptTokens"`);
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "completionTokens"`);
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "totalTokens"`);
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "latencyMs"`);
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "temperature"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-add the dropped Guess columns (nullable, no default — safe).
    await queryRunner.query(`ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "promptTokens" INT NULL`);
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "completionTokens" INT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "totalTokens" INT NULL`);
    await queryRunner.query(`ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "latencyMs" INT NULL`);
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "temperature" DOUBLE PRECISION NULL`,
    );

    // Remove solvePromptId from LlmProposal, restore promptNumber.
    await queryRunner.query(`ALTER TABLE "LlmProposal" DROP COLUMN IF EXISTS "solvePromptId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_LlmProposal_solvePromptId"`);
    await queryRunner.query(`
      ALTER TABLE "LlmProposal"
        ADD COLUMN IF NOT EXISTS "promptNumber" INT NOT NULL DEFAULT 1
    `);

    // Drop the SolvePrompt table and its index.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_SolvePrompt_strategyRunId"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "SolvePrompt"`);

    // Drop the new enum types.
    await queryRunner.query(`DROP TYPE IF EXISTS solve_prompt_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS solve_prompt_type_enum`);

    // NOTE: We do not drop the new llm_proposal_status_enum values
    // (supersededByRetry, invalidItems) because Postgres does not support
    // removing individual enum values.  The enum will contain stale values
    // after rollback, which is acceptable.
  }
}
