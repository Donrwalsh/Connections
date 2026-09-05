import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers three more Groq free-tier chat models for the llm-groq strategy,
 * on top of the four seeded in 1781000000000-add-groq-models.ts:
 *
 *   - llama-3.3-70b-versatile  (Meta, production, 131K context)
 *   - llama-3.1-8b-instant     (Meta, production, 131K context —
 *                               the "small/cheap default" role,
 *                               same slot gpt-oss-20b fills)
 *   - minimaxai/minimax-m2.7   (MiniMax, preview, 196K context)
 *
 * The two Llama models are seeded supported = true and emit plain structured
 * output that fits this repo's generateObject solve prompts, so no
 * strategy/dispatch code changes: the GroqFreeDispatchService cycle,
 * GroqRateLimitHold parking, the groqBurn automation leg, and
 * ModelMetadataRefreshService all enumerate llm-groq models straight from
 * SupportedModel and pick them up automatically.
 *
 * minimaxai/minimax-m2.7 is seeded supported = false — the same operator
 * lever 1780000000000-unset-legacy-gemini-flash-support.ts uses (see
 * supported-model.service.ts). The row is registered so a follow-up only has
 * to flip the flag, but GroqFreeDispatchService will not dispatch trials
 * against it until then. It stayed out of the original seed
 * (see docs/superpowers/specs/2026-09-04-groq-free-tier-design.md non-goals)
 * because its free-tier rate-limit row was unconfirmed at spec time, and
 * OpenRouter still has no matching model to source metadata/pricing from
 * (see below). The header-based RPD parking is model-agnostic and will cover
 * it once it is flipped on.
 *
 * openRouterSlug, per this repo's never-guess-a-slug policy (see
 * 1785000000000-set-groq-model-openrouter-slugs.ts), was confirmed live via
 * GET https://openrouter.ai/api/v1/models/{slug}/endpoints as of this
 * migration's authoring:
 *
 *   - llama-3.3-70b-versatile -> meta-llama/llama-3.3-70b-instruct: Groq is
 *     a live OpenRouter endpoint for this slug (131,072 ctx, ~$0.59/$0.79
 *     per M tok), so the model-metadata refresh's pricing will reflect
 *     Groq's own published rate.
 *   - llama-3.1-8b-instant -> meta-llama/llama-3.1-8b-instruct: Groq is a
 *     live OpenRouter endpoint for this slug (131,072 ctx, ~$0.05/$0.08 per
 *     M tok), likewise Groq-routed pricing.
 *   - minimaxai/minimax-m2.7: left NULL. OpenRouter has no matching model
 *     (GET .../minimaxai/minimax-m2.7/endpoints returns 404); minimax/minimax-m2
 *     is a distinct model (different context window and release) with no Groq
 *     endpoint, so pointing at it would backfill wrong metadata. Revisit when
 *     OpenRouter lists this model.
 *
 * No ModelPrice/contextWindow backfill happens in this migration itself —
 * that comes from ModelMetadataRefreshService's next run. Trigger
 * POST /dispatch/refresh-model-metadata once after this migration deploys,
 * so the two slugged rows aren't left blank until the next daily cron tick.
 */
export class AddMoreGroqModels1787000000000 implements MigrationInterface {
  name = "AddMoreGroqModels1787000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
      VALUES
        ('llm-groq', 'llama-3.3-70b-versatile', true, 'meta-llama/llama-3.3-70b-instruct'),
        ('llm-groq', 'llama-3.1-8b-instant', true, 'meta-llama/llama-3.1-8b-instruct'),
        ('llm-groq', 'minimaxai/minimax-m2.7', false, NULL)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-groq'
        AND "modelName" IN ('llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'minimaxai/minimax-m2.7')
    `);
  }
}
