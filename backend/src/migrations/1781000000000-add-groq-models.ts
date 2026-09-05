import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers the four Groq free-tier chat models this pass supports —
 * openai/gpt-oss-120b, openai/gpt-oss-20b, qwen/qwen3.6-27b, and
 * qwen/qwen3.8-27b — for the llm-groq strategy. Deliberately excludes
 * Groq's audio (whisper-*), TTS (canopylabs/orpheus-*), classifier
 * (meta-llama/llama-prompt-guard-2-*, openai/gpt-oss-safeguard-20b), and
 * tool-calling agent (groq/compound*) models, none of which fit this
 * repo's structured-JSON solve prompts — and minimax-m2.7, which has no
 * confirmed free-tier rate-limit row. openRouterSlug is left NULL per this
 * repo's never-guess-a-slug policy (see
 * 1771000000000-backfill-openrouter-slugs.ts and
 * 1774000000000-add-google-models.ts) — each slug must be confirmed live
 * via GET https://openrouter.ai/api/v1/models/{slug}/endpoints before being
 * set by hand, since OpenRouter may not list a Groq-hosted model under a
 * "groq/" prefix. Trigger POST /dispatch/refresh-model-metadata once slugs
 * are set, so contextWindow/pricing aren't left blank until the next daily
 * cron tick. See docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
export class AddGroqModels1781000000000 implements MigrationInterface {
  name = "AddGroqModels1781000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
      VALUES
        ('llm-groq', 'openai/gpt-oss-120b', true, NULL),
        ('llm-groq', 'openai/gpt-oss-20b', true, NULL),
        ('llm-groq', 'qwen/qwen3.6-27b', true, NULL),
        ('llm-groq', 'qwen/qwen3.8-27b', true, NULL)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-groq'
        AND "modelName" IN ('openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b', 'qwen/qwen3.8-27b')
    `);
  }
}
