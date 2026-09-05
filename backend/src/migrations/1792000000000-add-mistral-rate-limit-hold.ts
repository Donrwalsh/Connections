import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the MistralRateLimitHold table (one row per Mistral model held for a
 * rate-limit / monthly-quota hit) — the Mistral counterpart to
 * GroqRateLimitHold. No enum value migration needed here: 'rateLimitedDaily'
 * already exists on strategy_run_status_enum from
 * 1777000000000-add-google-rate-limit-hold.ts and is reused as-is. resetAt
 * is a short fixed fallback (MISTRAL_MODEL_HOLD_FALLBACK_SECONDS), not a
 * per-hit header duration — Mistral's free tier sends no rate-limit headers.
 * See docs/superpowers/specs/2026-09-05-mistral-la-plateforme-free-tier-design.md §3.
 */
export class AddMistralRateLimitHold1792000000000 implements MigrationInterface {
  name = "AddMistralRateLimitHold1792000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "MistralRateLimitHold" (
        "id" SERIAL PRIMARY KEY,
        "strategyName" TEXT NOT NULL,
        "modelName" TEXT NOT NULL,
        "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "UQ_MistralRateLimitHold_strategyName_modelName"
          UNIQUE ("strategyName", "modelName")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_MistralRateLimitHold_resetAt"
       ON "MistralRateLimitHold" ("resetAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "MistralRateLimitHold"`);
  }
}
