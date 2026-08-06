import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Baseline schema, mirroring database/01-schema.sql. Idempotent so it is a
 * no-op on databases already initialized by the docker-entrypoint-initdb.d
 * script and still bootstraps a completely empty database (e.g. CI, fresh
 * local Postgres without the init script).
 */
export class InitialSchema1754400000000 implements MigrationInterface {
  name = "InitialSchema1754400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE strategy_run_status_enum AS ENUM ('running', 'completed', 'failed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE guess_result_enum AS ENUM ('success', 'failure', 'offBy1');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE guess_source_enum AS ENUM ('user', 'strategy');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "Guess"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "StrategyRun"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "GroupMember"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "AnswerGroup"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "Puzzle"`);
    await queryRunner.query(`DROP TYPE IF EXISTS guess_source_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS guess_result_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS strategy_run_status_enum`);
  }
}
