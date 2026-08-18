import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds 'mistral' as a supported model for the llm-ollama strategy, with its
 * current price ($0.075/M input, $0.10/M output tokens).
 */
export class AddMistralModel1757000000000 implements MigrationInterface {
  name = "AddMistralModel1757000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported")
      VALUES ('llm-ollama', 'mistral', true)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "ModelPrice"
        ("supportedModelId", "inputCostPerMillionTokens", "outputCostPerMillionTokens")
      SELECT "id", 0.075, 0.1
      FROM "SupportedModel"
      WHERE "strategyName" = 'llm-ollama' AND "modelName" = 'mistral'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ModelPrice rows for this model cascade-delete via its FK to
    // SupportedModel — see SplitModelPrice1756000000000.
    await queryRunner.query(`
      DELETE FROM "SupportedModel" WHERE "strategyName" = 'llm-ollama' AND "modelName" = 'mistral'
    `);
  }
}
