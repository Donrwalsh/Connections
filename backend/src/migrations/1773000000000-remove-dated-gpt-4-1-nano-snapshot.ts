import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Removes the 'gpt-4.1-nano-2025-04-14' SupportedModel row — a legacy dated
 * snapshot registration with no matching dated slug on OpenRouter (only the
 * undated 'openai/gpt-4.1-nano' exists there — see
 * 1772000000000-backfill-remaining-openrouter-slugs.ts's comment), left
 * unmapped rather than reused against a slug that isn't actually a match
 * for its own identity, and now removed outright per explicit decision
 * rather than kept around as a permanently-unmapped row.
 *
 * ModelPrice.supportedModelId has onDelete: CASCADE, so this also removes
 * this model's price history — no separate delete needed. Any historical
 * StrategyRun rows recorded against this modelName are unaffected
 * (StrategyRun.modelName is a plain string, not a foreign key) — they
 * simply stop resolving to a SupportedModel row, the same as any other
 * model that predates its own registration.
 */
export class RemoveDatedGpt41NanoSnapshot1773000000000 implements MigrationInterface {
  name = "RemoveDatedGpt41NanoSnapshot1773000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-openai' AND "modelName" = 'gpt-4.1-nano-2025-04-14'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores the row itself (matching how it originally looked, per
    // 1755000000000-add-supported-model.ts) but not its deleted ModelPrice
    // history — cascade deletes aren't reversible.
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported")
      VALUES ('llm-openai', 'gpt-4.1-nano-2025-04-14', true)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }
}
