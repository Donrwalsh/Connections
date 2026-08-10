import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Promotes the solve-step sampling parameters reported by the orchestrator
 * (temperature, numResponses, promptAttempts, duplicatesRejected) and the
 * total token usage out of the free-form llmDetails JSON blob into dedicated,
 * queryable columns on "Guess" — mirroring database/01-schema.sql. Idempotent
 * so it is a no-op on databases initialized by the docker-entrypoint-initdb.d
 * script (which already contains these columns) and upgrades databases
 * bootstrapped by the baseline migration.
 */
export class LlmSolveParams1786377505000 implements MigrationInterface {
  name = "LlmSolveParams1786377505000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "totalTokens" INT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "temperature" DOUBLE PRECISION NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "numResponses" INT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "promptAttempts" INT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "Guess" ADD COLUMN IF NOT EXISTS "duplicatesRejected" INT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "duplicatesRejected"`);
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "promptAttempts"`);
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "numResponses"`);
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "temperature"`);
    await queryRunner.query(`ALTER TABLE "Guess" DROP COLUMN IF EXISTS "totalTokens"`);
  }
}
