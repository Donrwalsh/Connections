import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the smaller/cheaper OpenAI model tier (mini/nano variants, plus the
 * o3-mini/o4-mini reasoning models) as supported for the llm-openai
 * strategy, with per-1M-token pricing as of August 2026 (standard tier).
 * Complements AddOpenAiModels1759000000000, which added the flagship-tier
 * models.
 */
export class AddOpenAiMiniModels1760000000000 implements MigrationInterface {
  name = "AddOpenAiMiniModels1760000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported")
      VALUES
        ('llm-openai', 'gpt-5.4-mini', true),
        ('llm-openai', 'gpt-5.4-nano', true),
        ('llm-openai', 'gpt-5-mini', true),
        ('llm-openai', 'gpt-4.1-mini', true),
        ('llm-openai', 'gpt-4.1-nano', true),
        ('llm-openai', 'gpt-4o-mini', true),
        ('llm-openai', 'o3-mini', true),
        ('llm-openai', 'o4-mini', true)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "ModelPrice"
        ("supportedModelId", "inputCostPerMillionTokens", "outputCostPerMillionTokens")
      SELECT sm."id", v."inputCost", v."outputCost"
      FROM (VALUES
        ('gpt-5.4-mini', 0.75, 4.50),
        ('gpt-5.4-nano', 0.20, 1.25),
        ('gpt-5-mini', 0.25, 2.00),
        ('gpt-4.1-mini', 0.40, 1.60),
        ('gpt-4.1-nano', 0.10, 0.40),
        ('gpt-4o-mini', 0.15, 0.60),
        ('o3-mini', 1.10, 4.40),
        ('o4-mini', 1.10, 4.40)
      ) AS v("modelName", "inputCost", "outputCost")
      JOIN "SupportedModel" sm
        ON sm."strategyName" = 'llm-openai' AND sm."modelName" = v."modelName"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ModelPrice rows for these models cascade-delete via their FK to
    // SupportedModel — see SplitModelPrice1756000000000.
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-openai'
        AND "modelName" IN (
          'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-4.1-mini',
          'gpt-4.1-nano', 'gpt-4o-mini', 'o3-mini', 'o4-mini'
        )
    `);
  }
}
