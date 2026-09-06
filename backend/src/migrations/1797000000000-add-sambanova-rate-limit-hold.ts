import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the SambaNovaRateLimitHold table (one row per SambaNova model held
 * for hitting a free-tier per-day quota) — a structural copy of
 * GroqRateLimitHold. No enum migration needed: 'rateLimitedDaily' already
 * exists on strategy_run_status_enum and is reused as-is. resetAt is heldAt
 * plus that hit's parsed reset-duration header (see
 * orchestrator/src/solver.ts's sambanova branch). See
 * docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md.
 */
export class AddSambaNovaRateLimitHold1797000000000 implements MigrationInterface {
  name = "AddSambaNovaRateLimitHold1797000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "SambaNovaRateLimitHold" (
        "id" SERIAL PRIMARY KEY,
        "strategyName" TEXT NOT NULL,
        "modelName" TEXT NOT NULL,
        "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "UQ_SambaNovaRateLimitHold_strategyName_modelName"
          UNIQUE ("strategyName", "modelName")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_SambaNovaRateLimitHold_resetAt"
       ON "SambaNovaRateLimitHold" ("resetAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "SambaNovaRateLimitHold"`);
  }
}
