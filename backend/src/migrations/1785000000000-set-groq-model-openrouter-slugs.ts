import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Sets openRouterSlug for the four llm-groq models seeded in
 * 1781000000000-add-groq-models.ts, confirmed live via
 * GET https://openrouter.ai/api/v1/models/{slug}/endpoints as of this
 * migration's authoring, per this repo's never-guess-a-slug policy (see
 * 1771000000000-backfill-openrouter-slugs.ts).
 *
 * openai/gpt-oss-120b and openai/gpt-oss-20b: Groq is listed among their
 * live OpenRouter endpoints, so the model-metadata refresh's pricing will
 * reflect Groq's own published rate.
 *
 * qwen/qwen3.6-27b and qwen/qwen3.8-27b: both exist on OpenRouter with real
 * endpoints, but Groq is not currently one of them (only Chutes,
 * SiliconFlow, Phala, DeepInfra, Venice, Alibaba, and similar third-party
 * hosts as of this migration). Setting the slug anyway backfills accurate
 * context-window/description/release-date metadata for the model itself;
 * the resulting ModelPrice row will reflect whichever non-Groq provider
 * OpenRouter's /models listing prices by default, not Groq's own (free-tier)
 * rate — an accepted approximation until OpenRouter adds a Groq-routed
 * endpoint for these two models.
 *
 * No ModelPrice/contextWindow backfill happens in this migration itself —
 * that comes from ModelMetadataRefreshService's next run. Trigger
 * POST /dispatch/refresh-model-metadata once after this migration deploys,
 * so the four models aren't left blank until the next daily cron tick.
 */
export class SetGroqModelOpenRouterSlugs1785000000000 implements MigrationInterface {
  name = "SetGroqModelOpenRouterSlugs1785000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET "openRouterSlug" = CASE "modelName"
        WHEN 'openai/gpt-oss-120b' THEN 'openai/gpt-oss-120b'
        WHEN 'openai/gpt-oss-20b' THEN 'openai/gpt-oss-20b'
        WHEN 'qwen/qwen3.6-27b' THEN 'qwen/qwen3.6-27b'
        WHEN 'qwen/qwen3.8-27b' THEN 'qwen/qwen3.8-27b'
      END
      WHERE "strategyName" = 'llm-groq'
        AND "modelName" IN ('openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b', 'qwen/qwen3.8-27b')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET "openRouterSlug" = NULL
      WHERE "strategyName" = 'llm-groq'
        AND "modelName" IN ('openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b', 'qwen/qwen3.8-27b')
    `);
  }
}
