import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds SupportedModel.freeTier and backfills it with the model→program
 * assignments that previously lived as hardcoded FLAGSHIP_FREE_TIER/
 * MINI_FREE_TIER constants in free-tier-usage.service.ts. From here on,
 * changing which models count toward a free-tier program is a direct edit
 * to this column (e.g. via Adminer), not a code change or migration.
 */
export class AddSupportedModelFreeTier1766000000000 implements MigrationInterface {
  name = "AddSupportedModelFreeTier1766000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "SupportedModel" ADD COLUMN "freeTier" text`);

    await queryRunner.query(`
      UPDATE "SupportedModel" SET "freeTier" = 'flagship'
      WHERE "strategyName" = 'llm-openai'
        AND "modelName" IN ('gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'o1', 'o3')
    `);

    await queryRunner.query(`
      UPDATE "SupportedModel" SET "freeTier" = 'mini'
      WHERE "strategyName" = 'llm-openai'
        AND "modelName" IN (
          'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-4.1-mini',
          'gpt-4.1-nano', 'gpt-4o-mini', 'o3-mini', 'o4-mini', 'gpt-5-nano'
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "SupportedModel" DROP COLUMN "freeTier"`);
  }
}
