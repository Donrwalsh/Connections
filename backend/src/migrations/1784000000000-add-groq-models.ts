import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers the six Groq models this pass supports for the llm-groq
 * strategy. Four have OpenRouter slugs (meta-llama/llama-3.1-8b-instruct,
 * meta-llama/llama-3.3-70b-instruct, openai/gpt-oss-20b,
 * openai/gpt-oss-120b) — verified live via OpenRouter's endpoints endpoint,
 * per this repo's never-guess-a-slug policy — and get their context window /
 * price scope from ModelMetadataRefreshService on the next run. The two
 * Qwen previews (qwen3.6-27b, qwen3.8-27b) have no Groq endpoint on
 * OpenRouter yet (and OpenRouter lists them under an 8k-context description
 * that doesn't match Groq's real context, so they can't be served off the
 * list endpoint), so they're hand-seeded with their full metadata and are
 * never touched by refresh.
 *
 * priceScopeProvider='Groq' on the slugged models makes refresh price them
 * from Groq's own OpenRouter endpoint rather than the list-level aggregate
 * (which can understate what Groq charges). Prices below are Groq's official
 * per-1M-token rates as of this migration's authoring; refresh re-derives
 * them and inserts a new ModelPrice row only if they differ. Trigger
 * POST /dispatch/refresh-model-metadata once after this migration deploys so
 * the slugged models aren't left blank until the next daily cron tick.
 * See docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
export class AddGroqModels1784000000000 implements MigrationInterface {
  name = "AddGroqModels1784000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "SupportedModel" ADD COLUMN "priceScopeProvider" TEXT`);

    await queryRunner.query(`
      INSERT INTO "SupportedModel"
        ("strategyName", "modelName", "supported", "openRouterSlug", "priceScopeProvider", "contextWindow", "paramCount")
      VALUES
        ('llm-groq', 'llama-3.1-8b-instant', true, 'meta-llama/llama-3.1-8b-instruct', 'Groq', NULL, NULL),
        ('llm-groq', 'llama-3.3-70b-versatile', true, 'meta-llama/llama-3.3-70b-instruct', 'Groq', NULL, NULL),
        ('llm-groq', 'openai/gpt-oss-20b', true, 'openai/gpt-oss-20b', 'Groq', NULL, NULL),
        ('llm-groq', 'openai/gpt-oss-120b', true, 'openai/gpt-oss-120b', 'Groq', NULL, NULL),
        ('llm-groq', 'qwen/qwen3.6-27b', true, NULL, NULL, 131072, 27000000000),
        ('llm-groq', 'qwen/qwen3.8-27b', true, NULL, NULL, 131042, 27000000000)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "ModelPrice"
        ("supportedModelId", "inputCostPerMillionTokens", "outputCostPerMillionTokens")
      SELECT sm."id", p.in, p.out
      FROM "SupportedModel" sm
      JOIN (VALUES
        ('llama-3.1-8b-instant', 0.05, 0.08),
        ('llama-3.3-70b-versatile', 0.59, 0.79),
        ('openai/gpt-oss-20b', 0.075, 0.30),
        ('openai/gpt-oss-120b', 0.15, 0.60),
        ('qwen/qwen3.6-27b', 0.60, 3.00),
        ('qwen/qwen3.8-27b', 0.80, 4.00)
      ) AS p(modelName, in, out) ON p.modelName = sm."modelName"
      WHERE sm."strategyName" = 'llm-groq'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "ModelPrice"
      WHERE "supportedModelId" IN (
        SELECT "id" FROM "SupportedModel" WHERE "strategyName" = 'llm-groq'
      )
    `);
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-groq'
        AND "modelName" IN (
          'llama-3.1-8b-instant', 'llama-3.3-70b-versatile',
          'openai/gpt-oss-20b', 'openai/gpt-oss-120b',
          'qwen/qwen3.6-27b', 'qwen/qwen3.8-27b'
        )
    `);
    await queryRunner.query(`ALTER TABLE "SupportedModel" DROP COLUMN "priceScopeProvider"`);
  }
}
