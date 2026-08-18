import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Allowlist of models each LLM strategy may dispatch runs against, plus the
 * per-1M-token cost data needed to price a run. A strategy run for an LLM
 * strategy can only be dispatched for a model that has a row here with
 * `supported = true` — see SupportedModelService.assertSupported.
 */
export class AddSupportedModel1755000000000 implements MigrationInterface {
  name = "AddSupportedModel1755000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "SupportedModel" (
        "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "strategyName" VARCHAR NOT NULL,
        "modelName" VARCHAR NOT NULL,
        "inputCostPerMillionTokens" DOUBLE PRECISION NOT NULL,
        "cachedInputCostPerMillionTokens" DOUBLE PRECISION NOT NULL,
        "outputCostPerMillionTokens" DOUBLE PRECISION NOT NULL,
        "supported" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "UQ_SupportedModel_strategyName_modelName" UNIQUE ("strategyName", "modelName")
      )
    `);

    await queryRunner.query(`
      INSERT INTO "SupportedModel"
        ("strategyName", "modelName", "inputCostPerMillionTokens",
         "cachedInputCostPerMillionTokens", "outputCostPerMillionTokens", "supported")
      VALUES
        ('llm-openai', 'gpt-4.1-nano-2025-04-14', 0.10, 0.025, 0.40, true),
        ('llm-openai', 'gpt-5-nano', 0.05, 0.005, 0.40, true)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "SupportedModel"`);
  }
}
