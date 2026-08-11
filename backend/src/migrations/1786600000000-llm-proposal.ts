import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the LlmProposal table, which records every candidate group the LLM
 * proposed across a solve step — including groups that repeated a prior guess
 * (rejected_duplicate) and fresh groups that lost to a higher-confidence
 * proposal in the same batch (not_selected) — mirroring
 * database/01-schema.sql. Idempotent so it is a no-op on databases initialized
 * by the docker-entrypoint-initdb.d script (which already contains this table)
 * and upgrades databases bootstrapped by the baseline migration.
 */
export class LlmProposal1786600000000 implements MigrationInterface {
  name = "LlmProposal1786600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE llm_proposal_status_enum AS ENUM
          ('used', 'rejected_duplicate', 'not_selected');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "LlmProposal" (
        "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "strategyRunId" INT NOT NULL REFERENCES "StrategyRun"("id") ON DELETE CASCADE,
        "guessId" INT NULL REFERENCES "Guess"("id") ON DELETE SET NULL,
        "promptNumber" INT NOT NULL,
        "guessNumber" INT NULL,
        "words" JSONB NOT NULL,
        "category" TEXT NOT NULL,
        "confidence" DOUBLE PRECISION NOT NULL,
        "reasoning" TEXT NOT NULL,
        "status" llm_proposal_status_enum NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_LlmProposal_strategyRunId" ON "LlmProposal" ("strategyRunId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_LlmProposal_guessId" ON "LlmProposal" ("guessId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "LlmProposal"`);
    await queryRunner.query(`DROP TYPE IF EXISTS llm_proposal_status_enum`);
  }
}
