import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers the four OpenRouter free-tier chat models this pass supports
 * for the llm-openrouter strategy. For this provider `modelName` IS the
 * OpenRouter slug (the ":free" id), and openRouterSlug is set to the same
 * value — each ":free" id is a real /api/v1/models catalog entry with its
 * own context_length/created/pricing, so ModelMetadataRefreshService fills
 * contextWindow/releaseDate/pricing on its next run. freeTier stays NULL
 * (OpenRouter is not part of either OpenAI token tier). Excludes tools-only
 * ":free" models with no response_format support (thinkingmachines/inkling,
 * nvidia/nemotron-3.5-lightning) and all audio/safety/embedding ":free"
 * entries. All four slugs re-confirmed live with response_format support
 * against GET /api/v1/models/{slug}/endpoints when this migration was
 * written. See docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md.
 */
export class AddOpenRouterModels1788000000000 implements MigrationInterface {
  name = "AddOpenRouterModels1788000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug", "freeTier")
      VALUES
        ('llm-openrouter', 'z-ai/glm-5.2:free',                     true, 'z-ai/glm-5.2:free',                     NULL),
        ('llm-openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', true, 'nvidia/nemotron-3-super-120b-a12b:free', NULL),
        ('llm-openrouter', 'minimax/minimax-m3:free',               true, 'minimax/minimax-m3:free',               NULL),
        ('llm-openrouter', 'google/gemma-4-31b-it:free',            true, 'google/gemma-4-31b-it:free',            NULL)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-openrouter'
        AND "modelName" IN (
          'z-ai/glm-5.2:free', 'nvidia/nemotron-3-super-120b-a12b:free',
          'minimax/minimax-m3:free', 'google/gemma-4-31b-it:free'
        )
    `);
  }
}
