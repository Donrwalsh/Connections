import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the OpenRouterRateLimitHold table — a SINGLE row (unique on
 * strategyName) marking the whole llm-openrouter strategy held, since
 * OpenRouter's free-tier caps are account-wide, not per-model. No enum
 * migration needed: 'rateLimitedDaily' already exists on
 * strategy_run_status_enum and is reused. See
 * docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md.
 */
export class AddOpenRouterRateLimitHold1789000000000 implements MigrationInterface {
  name = "AddOpenRouterRateLimitHold1789000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "OpenRouterRateLimitHold" (
        "id" SERIAL PRIMARY KEY,
        "strategyName" TEXT NOT NULL,
        "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reason" TEXT NOT NULL,
        CONSTRAINT "UQ_OpenRouterRateLimitHold_strategyName" UNIQUE ("strategyName")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_OpenRouterRateLimitHold_resetAt"
       ON "OpenRouterRateLimitHold" ("resetAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "OpenRouterRateLimitHold"`);
  }
}
