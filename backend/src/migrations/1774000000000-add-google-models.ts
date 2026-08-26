import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers the two Google AI Studio models this pass supports —
 * gemini-2.5-flash and gemini-2.5-flash-lite — for the llm-google strategy.
 * Both openRouterSlug values were confirmed live via
 * GET https://openrouter.ai/api/v1/models/{slug}/endpoints (non-empty
 * endpoints array, real pricing) as of this migration's authoring, per this
 * repo's never-guess-a-slug policy (see
 * 1771000000000-backfill-openrouter-slugs.ts). No ModelPrice row is
 * inserted here — being pre-mapped, both models get their first price
 * (along with contextWindow/paramCount/providerDescription/releaseDate)
 * from ModelMetadataRefreshService's next run rather than a hand-entered
 * value. Trigger POST /dispatch/refresh-model-metadata once after this
 * migration deploys, so the models aren't left blank until the next daily
 * cron tick.
 */
export class AddGoogleModels1774000000000 implements MigrationInterface {
  name = "AddGoogleModels1774000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
      VALUES
        ('llm-google', 'gemini-2.5-flash', true, 'google/gemini-2.5-flash'),
        ('llm-google', 'gemini-2.5-flash-lite', true, 'google/gemini-2.5-flash-lite')
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-google'
        AND "modelName" IN ('gemini-2.5-flash', 'gemini-2.5-flash-lite')
    `);
  }
}
