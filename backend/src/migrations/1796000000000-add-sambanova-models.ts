import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers five SambaNova Cloud free-tier chat models for the
 * llm-sambanova strategy: three production (DeepSeek-V3.1,
 * Meta-Llama-3.3-70B-Instruct, gpt-oss-120b) plus two preview
 * (DeepSeek-V3.2, gemma-4-31B-it).
 *
 * `modelName` is SambaNova's own model id; `openRouterSlug` is the separate
 * OpenRouter-catalog mapping ModelMetadataRefreshService uses to backfill
 * contextWindow / pricing / releaseDate (the Groq/Mistral split, not
 * OpenRouter's identical-value seeding). Slugs were confirmed live against
 * OpenRouter model pages at implementation time. `freeTier` is left NULL
 * (SambaNova is not part of either OpenAI token tier).
 *
 * All five are seeded `supported = true`. gpt-oss-120b is the confirmed
 * structured-output anchor; the other four use SambaNova's OpenAI-compatible
 * `response_format` support. Re-run a real `response_format` probe against
 * api.sambanova.ai with a live key and flip any model that cannot reliably
 * return structured output to `supported = false` (as minimax-m2.7 was for
 * Groq) — keep the row either way so metadata still backfills. The two
 * "preview" models (DeepSeek-V3.2, gemma-4-31B-it) may be withdrawn by
 * SambaNova with little notice; a delisted id then flips to
 * `supported = false` rather than being dropped.
 *
 * Trigger POST /dispatch/refresh-model-metadata once applied so
 * contextWindow / pricing aren't left blank until the next daily cron tick.
 * See docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md §8.
 */
export class AddSambaNovaModels1796000000000 implements MigrationInterface {
  name = "AddSambaNovaModels1796000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
      VALUES
        ('llm-sambanova', 'DeepSeek-V3.1',               true, 'deepseek/deepseek-chat-v3.1'),
        ('llm-sambanova', 'DeepSeek-V3.2',               true, 'deepseek/deepseek-v3.2'),
        ('llm-sambanova', 'Meta-Llama-3.3-70B-Instruct', true, 'meta-llama/llama-3.3-70b-instruct'),
        ('llm-sambanova', 'gpt-oss-120b',                true, 'openai/gpt-oss-120b'),
        ('llm-sambanova', 'gemma-4-31B-it',              true, 'google/gemma-4-31b-it')
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-sambanova'
        AND "modelName" IN (
          'DeepSeek-V3.1', 'DeepSeek-V3.2', 'Meta-Llama-3.3-70B-Instruct',
          'gpt-oss-120b', 'gemma-4-31B-it'
        )
    `);
  }
}
