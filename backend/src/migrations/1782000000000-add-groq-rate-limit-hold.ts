import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the GroqRateLimitHold table (one row per Groq model held for hitting
 * its free-tier requests-per-day quota) — the Groq counterpart to
 * GoogleRateLimitHold. No enum value migration needed here:
 * 'rateLimitedDaily' already exists on strategy_run_status_enum from
 * 1777000000000-add-google-rate-limit-hold.ts and is reused as-is. See
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
export class AddGroqRateLimitHold1782000000000 implements MigrationInterface {
  name = "AddGroqRateLimitHold1782000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "GroqRateLimitHold" (
        "id" SERIAL PRIMARY KEY,
        "strategyName" TEXT NOT NULL,
        "modelName" TEXT NOT NULL,
        "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "UQ_GroqRateLimitHold_strategyName_modelName"
          UNIQUE ("strategyName", "modelName")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_GroqRateLimitHold_resetAt"
       ON "GroqRateLimitHold" ("resetAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "GroqRateLimitHold"`);
  }
}
