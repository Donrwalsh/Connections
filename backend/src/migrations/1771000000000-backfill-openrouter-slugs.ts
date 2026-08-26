import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backfills openRouterSlug for models confirmed live on OpenRouter as of
 * this migration's authoring (checked via GET /api/v1/models/{slug}/endpoints
 * — a non-empty endpoints array with real pricing). Only two are confirmed
 * here; the rest of the registered OpenAI models haven't been checked and
 * are deliberately left unmapped rather than guessed — see the "Historical
 * cost accuracy" / Task 2 note in docs/superpowers/plans/2026-08-26-model-metadata-refresh.md
 * for why.
 */
export class BackfillOpenRouterSlugs1771000000000 implements MigrationInterface {
  name = "BackfillOpenRouterSlugs1771000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel" SET "openRouterSlug" = 'openai/gpt-4.1-nano'
      WHERE "strategyName" = 'llm-openai' AND "modelName" = 'gpt-4.1-nano'
    `);
    await queryRunner.query(`
      UPDATE "SupportedModel" SET "openRouterSlug" = 'mistralai/mistral-nemo'
      WHERE "strategyName" = 'llm-ollama' AND "modelName" = 'mistral-nemo'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel" SET "openRouterSlug" = NULL
      WHERE "openRouterSlug" IN ('openai/gpt-4.1-nano', 'mistralai/mistral-nemo')
    `);
  }
}
