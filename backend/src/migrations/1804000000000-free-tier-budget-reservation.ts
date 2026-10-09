import { MigrationInterface, QueryRunner } from "typeorm";

// Seeded from prod SolvePrompt.completionTokens (queried 2026-10-08): max
// observed × 1.2, rounded up to the next 1,000, floor 1,000 — no call ever
// recorded would have been cut off. See
// docs/specs/2026-10-08-free-tier-budget-reservation-design.md.
const OPENAI_MAX_OUTPUT_TOKENS: ReadonlyArray<[string, number]> = [
  ["o4-mini", 49_000],
  ["gpt-5", 47_000],
  ["o3", 46_000],
  ["gpt-5-nano", 36_000],
  ["o1", 33_000],
  ["o3-mini", 29_000],
  ["gpt-5-mini", 27_000],
  ["gpt-4.1-mini", 14_000],
  ["gpt-4.1-nano", 4_000],
  ["gpt-4.1", 2_000],
  ["gpt-4o", 1_000],
  ["gpt-4o-mini", 1_000],
  ["gpt-5.1", 1_000],
  ["gpt-5.2", 1_000],
  ["gpt-5.4", 1_000],
  ["gpt-5.4-mini", 1_000],
  ["gpt-5.4-nano", 1_000],
];

/** Per-model output caps, StrategyRun.budgetTier, and the
 * FreeTierReservation ledger behind free-tier budget reservations. */
export class FreeTierBudgetReservation1804000000000 implements MigrationInterface {
  name = "FreeTierBudgetReservation1804000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "SupportedModel" ADD COLUMN IF NOT EXISTS "maxOutputTokens" INT`,
    );
    for (const [modelName, maxOutputTokens] of OPENAI_MAX_OUTPUT_TOKENS) {
      await queryRunner.query(
        `UPDATE "SupportedModel" SET "maxOutputTokens" = $1
          WHERE "strategyName" = 'llm-openai' AND "modelName" = $2`,
        [maxOutputTokens, modelName],
      );
    }

    await queryRunner.query(
      `ALTER TABLE "StrategyRun" ADD COLUMN IF NOT EXISTS "budgetTier" VARCHAR`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "FreeTierReservation" (
        "id" SERIAL PRIMARY KEY,
        "tier" VARCHAR NOT NULL,
        "strategyRunId" INT NOT NULL REFERENCES "StrategyRun"("id") ON DELETE CASCADE,
        "reservedTokens" INT NOT NULL,
        "status" VARCHAR NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_FreeTierReservation_tier_createdAt"
        ON "FreeTierReservation" ("tier", "createdAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "FreeTierReservation"`);
    await queryRunner.query(`ALTER TABLE "StrategyRun" DROP COLUMN IF EXISTS "budgetTier"`);
    await queryRunner.query(`ALTER TABLE "SupportedModel" DROP COLUMN IF EXISTS "maxOutputTokens"`);
  }
}
