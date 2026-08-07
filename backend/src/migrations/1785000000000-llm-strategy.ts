import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the LLM strategy outcome + telemetry columns, mirroring
 * database/01-schema.sql. Idempotent so it is a no-op on databases
 * initialized by the docker-entrypoint-initdb.d script (which already
 * contains these values/columns) and upgrades databases bootstrapped by
 * the baseline migration.
 */
export class LlmStrategy1785000000000 implements MigrationInterface {
  name = "LlmStrategy1785000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE strategy_run_status_enum ADD VALUE IF NOT EXISTS 'duplicate'`,
    );
    await queryRunner.query(
      `ALTER TYPE strategy_run_status_enum ADD VALUE IF NOT EXISTS 'malformedResponse'`,
    );
    await queryRunner.query(`ALTER TYPE strategy_run_status_enum ADD VALUE IF NOT EXISTS 'error'`);
    await queryRunner.query(`ALTER TYPE guess_result_enum ADD VALUE IF NOT EXISTS 'duplicate'`);

    await queryRunner.query(
      `ALTER TABLE "StrategyRun" ADD COLUMN IF NOT EXISTS "modelName" VARCHAR NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "StrategyRun" ADD COLUMN IF NOT EXISTS "contextWindow" INT NULL`,
    );

    await queryRunner.query(`ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "promptTokens" INT NULL`);
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "completionTokens" INT NULL`,
    );
    await queryRunner.query(`ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "latencyMs" INT NULL`);
    await queryRunner.query(`ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "llmDetails" JSONB NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "llmDetails"`);
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "latencyMs"`);
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "completionTokens"`);
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "promptTokens"`);
    await queryRunner.query(`ALTER TABLE "StrategyRun" DROP COLUMN IF EXISTS "contextWindow"`);
    await queryRunner.query(`ALTER TABLE "StrategyRun" DROP COLUMN IF EXISTS "modelName"`);
  }
}
