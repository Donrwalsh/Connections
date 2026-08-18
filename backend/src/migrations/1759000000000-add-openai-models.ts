import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds a set of current OpenAI models as supported for the llm-openai
 * strategy, with per-1M-token pricing as of August 2026 (standard tier —
 * gpt-5.4's long-context breakpoint rate above 272K tokens isn't
 * represented, since ModelPrice has no notion of tiered pricing).
 */
export class AddOpenAiModels1759000000000 implements MigrationInterface {
  name = "AddOpenAiModels1759000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported")
      VALUES
        ('llm-openai', 'gpt-5.4', true),
        ('llm-openai', 'gpt-5.2', true),
        ('llm-openai', 'gpt-5.1', true),
        ('llm-openai', 'gpt-5', true),
        ('llm-openai', 'gpt-4.1', true),
        ('llm-openai', 'gpt-4o', true),
        ('llm-openai', 'o1', true),
        ('llm-openai', 'o3', true)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "ModelPrice"
        ("supportedModelId", "inputCostPerMillionTokens", "outputCostPerMillionTokens")
      SELECT sm."id", v."inputCost", v."outputCost"
      FROM (VALUES
        ('gpt-5.4', 2.50, 15.00),
        ('gpt-5.2', 1.75, 14.00),
        ('gpt-5.1', 1.25, 10.00),
        ('gpt-5', 1.25, 10.00),
        ('gpt-4.1', 2.00, 8.00),
        ('gpt-4o', 2.50, 10.00),
        ('o1', 15.00, 60.00),
        ('o3', 2.00, 8.00)
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
        AND "modelName" IN ('gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'o1', 'o3')
    `);
  }
}
