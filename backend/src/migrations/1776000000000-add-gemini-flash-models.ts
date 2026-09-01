import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers six additional llm-google Gemini Flash / Flash-Lite models in the
 * SupportedModel allowlist. Follows the insert pattern established by
 * 1774000000000-add-google-models.ts: rows carry only strategyName / modelName /
 * supported / openRouterSlug, and no ModelPrice row is inserted here — each
 * model gets its first price (plus contextWindow / paramCount /
 * providerDescription / releaseDate) from ModelMetadataRefreshService's next
 * run. Trigger POST /dispatch/refresh-model-metadata once after this migration
 * deploys so the new rows aren't left blank until the next daily cron tick.
 *
 * Slug verification: this repo's never-guess-a-slug policy (see
 * 1771000000000-backfill-openrouter-slugs.ts) requires every openRouterSlug to
 * be confirmed live via GET https://openrouter.ai/api/v1/models/{slug}/endpoints
 * (non-empty endpoints array, real pricing) before deploy. The slugs below
 * follow Google's "google/gemini-<version>-flash[-lite]" naming convention;
 * confirm each one resolves before running this in an environment that dispatches
 * real runs, and set openRouterSlug to NULL for any that does not yet exist on
 * OpenRouter (NULL = "not mapped, skip on refresh").
 *
 * Note: gemini-2.5-flash and gemini-2.5-flash-lite were renamed away in
 * 1775000000000-rename-gemini-flash-models.ts because Google's API had retired
 * them for new API keys. They are re-added here by request; verify they are
 * reachable with the target environment's Google credentials before relying on
 * them.
 */
export class AddGeminiFlashModels1776000000000 implements MigrationInterface {
  name = "AddGeminiFlashModels1776000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
      VALUES
        ('llm-google', 'gemini-3.1-flash-lite', true, 'google/gemini-3.1-flash-lite'),
        ('llm-google', 'gemini-3.5-flash', true, 'google/gemini-3.5-flash'),
        ('llm-google', 'gemini-3.7-flash', true, 'google/gemini-3.7-flash'),
        ('llm-google', 'gemini-3-flash', true, 'google/gemini-3-flash'),
        ('llm-google', 'gemini-2.5-flash', true, 'google/gemini-2.5-flash'),
        ('llm-google', 'gemini-2.5-flash-lite', true, 'google/gemini-2.5-flash-lite')
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-google'
        AND "modelName" IN (
          'gemini-3.1-flash-lite',
          'gemini-3.5-flash',
          'gemini-3.7-flash',
          'gemini-3-flash',
          'gemini-2.5-flash',
          'gemini-2.5-flash-lite'
        )
    `);
  }
}
