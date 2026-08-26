import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Renames the two llm-google SupportedModel rows registered in
 * 1774000000000-add-google-models.ts. gemini-2.5-flash/-lite turned out to
 * already be retired for new Google AI Studio API keys by the time this
 * shipped — Google's own API rejects calls to them with "This model ...
 * is no longer available to new users" — so this follows
 * 1769000000000-rename-mistral-to-mistral-nemo.ts's precedent: a plain
 * rename (UPDATE, not delete+insert) so the row id — and any StrategyRun
 * history that already accumulated under the old name — stays associated
 * with the same SupportedModel going forward.
 *
 * New openRouterSlug values confirmed live via
 * GET https://openrouter.ai/api/v1/models/{slug}/endpoints (non-empty
 * endpoints array, real pricing) as of this migration's authoring.
 * gemini-2.5-flash-lite has no same-generation replacement live on
 * OpenRouter — gemini-3.5-flash-lite is the current lite-tier model, one
 * generation behind gemini-3.6-flash's 3.6, which is what it stays paired
 * with rather than leaving the lite tier unmapped.
 */
export class RenameGeminiFlashModels1775000000000 implements MigrationInterface {
  name = "RenameGeminiFlashModels1775000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET "modelName" = 'gemini-3.6-flash', "openRouterSlug" = 'google/gemini-3.6-flash'
      WHERE "strategyName" = 'llm-google' AND "modelName" = 'gemini-2.5-flash'
    `);
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET "modelName" = 'gemini-3.5-flash-lite', "openRouterSlug" = 'google/gemini-3.5-flash-lite'
      WHERE "strategyName" = 'llm-google' AND "modelName" = 'gemini-2.5-flash-lite'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET "modelName" = 'gemini-2.5-flash', "openRouterSlug" = 'google/gemini-2.5-flash'
      WHERE "strategyName" = 'llm-google' AND "modelName" = 'gemini-3.6-flash'
    `);
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET "modelName" = 'gemini-2.5-flash-lite', "openRouterSlug" = 'google/gemini-2.5-flash-lite'
      WHERE "strategyName" = 'llm-google' AND "modelName" = 'gemini-3.5-flash-lite'
    `);
  }
}
