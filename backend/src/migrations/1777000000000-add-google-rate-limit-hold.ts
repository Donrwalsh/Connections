import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the GoogleRateLimitHold table (one row per Google model held for
 * hitting its free-tier requests-per-day quota) and a new
 * 'rateLimitedDaily' value on strategy_run_status_enum for a run parked by
 * such a hold. See
 * docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md.
 */
export class AddGoogleRateLimitHold1777000000000 implements MigrationInterface {
  name = "AddGoogleRateLimitHold1777000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "strategy_run_status_enum" ADD VALUE IF NOT EXISTS 'rateLimitedDaily'`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "GoogleRateLimitHold" (
        "id" SERIAL PRIMARY KEY,
        "strategyName" TEXT NOT NULL,
        "modelName" TEXT NOT NULL,
        "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "UQ_GoogleRateLimitHold_strategyName_modelName"
          UNIQUE ("strategyName", "modelName")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_GoogleRateLimitHold_resetAt"
       ON "GoogleRateLimitHold" ("resetAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "GoogleRateLimitHold"`);
    // Postgres has no "remove enum value" short of recreating the type, so
    // rolling back leaves 'rateLimitedDaily' a valid-but-unused status
    // value — harmless, same as 1767000000000-add-solve-prompt-call-detail.
  }
}
