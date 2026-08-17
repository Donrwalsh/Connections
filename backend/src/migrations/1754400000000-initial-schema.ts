import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Consolidated baseline schema representing the full target database layout.
 */
export class InitialSchema1754400000000 implements MigrationInterface {
  name = "InitialSchema1754400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Enums ──────────────────────────────────────────────────────────────

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE strategy_run_status_enum AS ENUM (
          'running', 'completed', 'failed', 'duplicate', 'malformedResponse', 'error'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE guess_result_enum AS ENUM ('success', 'failure', 'offBy1', 'duplicate');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE guess_source_enum AS ENUM ('user', 'strategy');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE llm_proposal_status_enum AS ENUM (
          'used', 'rejected_duplicate', 'not_selected', 'supersededByRetry', 'invalidItems'
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

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

    // ── Tables ─────────────────────────────────────────────────────────────

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "Puzzle" (
        "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "date" DATE NOT NULL,
        CONSTRAINT "UQ_Puzzle_date" UNIQUE ("date")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "AnswerGroup" (
        "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "puzzle_id" INT NOT NULL REFERENCES "Puzzle"("id"),
        "level" INT NOT NULL,
        "group_name" TEXT NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_AnswerGroup_puzzle_level"
        ON "AnswerGroup" ("puzzle_id", "level")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "GroupMember" (
        "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "group_id" INT NOT NULL REFERENCES "AnswerGroup"("id"),
        "word" TEXT NOT NULL,
        "position" INT NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_GroupMember_group_word"
        ON "GroupMember" ("group_id", "word")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "StrategyRun" (
        "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "puzzleId" INT NOT NULL REFERENCES "Puzzle"("id") ON DELETE CASCADE,
        "strategyName" VARCHAR NOT NULL,
        "trialNumber" INT NOT NULL DEFAULT 0,
        "status" strategy_run_status_enum NOT NULL DEFAULT 'running',
        "availableWords" JSONB NOT NULL,
        "currentCombination" JSONB NOT NULL,
        "modelName" VARCHAR NULL,
        "contextWindow" INT NULL,
        "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "finishedAt" TIMESTAMP WITH TIME ZONE NULL,
        CONSTRAINT "UQ_StrategyRun_puzzle_strategyName_trialNumber"
          UNIQUE ("puzzleId", "strategyName", "trialNumber")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "Guess" (
        "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "puzzleId" INT NOT NULL REFERENCES "Puzzle"("id") ON DELETE CASCADE,
        "strategyRunId" INT NULL REFERENCES "StrategyRun"("id") ON DELETE SET NULL,
        "words" JSONB NOT NULL,
        "result" guess_result_enum NOT NULL,
        "sequenceNumber" INT NOT NULL,
        "source" guess_source_enum NOT NULL,
        "guessedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_Guess_puzzleId" ON "Guess" ("puzzleId")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_Guess_strategyRun_sequenceNumber"
        ON "Guess" ("strategyRunId", "sequenceNumber") INCLUDE ("words")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "SolvePrompt" (
        "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "strategyRunId" INT NOT NULL REFERENCES "StrategyRun"("id") ON DELETE CASCADE,
        "promptNumber" INT NOT NULL,
        "promptType" solve_prompt_type_enum NOT NULL,
        "status" solve_prompt_status_enum NOT NULL DEFAULT 'parsed',
        "rawResponseText" TEXT NULL,
        "promptTokens" INT NULL,
        "completionTokens" INT NULL,
        "totalTokens" INT NULL,
        "latencyMs" INT NULL,
        "temperature" DOUBLE PRECISION NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "UQ_SolvePrompt_run_promptNumber" UNIQUE ("strategyRunId", "promptNumber")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_SolvePrompt_strategyRunId" ON "SolvePrompt" ("strategyRunId")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "LlmProposal" (
        "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "strategyRunId" INT NOT NULL REFERENCES "StrategyRun"("id") ON DELETE CASCADE,
        "solvePromptId" INT NOT NULL REFERENCES "SolvePrompt"("id") ON DELETE CASCADE,
        "guessId" INT NULL REFERENCES "Guess"("id") ON DELETE SET NULL,
        "promptNumber" INT NULL,
        "words" JSONB NOT NULL,
        "category" TEXT NOT NULL,
        "status" llm_proposal_status_enum NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_LlmProposal_strategyRunId" ON "LlmProposal" ("strategyRunId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_LlmProposal_guessId" ON "LlmProposal" ("guessId")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_LlmProposal_solvePromptId" ON "LlmProposal" ("solvePromptId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "LlmProposal"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "SolvePrompt"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "Guess"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "StrategyRun"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "GroupMember"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "AnswerGroup"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "Puzzle"`);

    await queryRunner.query(`DROP TYPE IF EXISTS solve_prompt_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS solve_prompt_type_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS llm_proposal_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS guess_source_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS guess_result_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS strategy_run_status_enum`);
  }
}
