import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Renames the llm-ollama 'mistral' SupportedModel row to 'mistral-nemo'.
 * Base Mistral 7B Instruct (Ollama's 'mistral' tag) has no live pricing on
 * OpenRouter — its ModelPrice row is placeholder data. mistral-nemo is a
 * comparable open-weight model that IS actively priced on OpenRouter, so
 * switching to it unblocks real price/context/param sourcing later.
 *
 * This is a plain rename (UPDATE, not delete+insert) so the SupportedModel
 * id — and therefore its ModelPrice history and any StrategyRun rows that
 * reference this model — stays intact. Existing ModelPrice rows are left
 * untouched; they'll simply be understood as mistral-nemo's price going
 * forward instead of mistral's.
 */
export class RenameMistralToMistralNemo1769000000000 implements MigrationInterface {
  name = "RenameMistralToMistralNemo1769000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET "modelName" = 'mistral-nemo'
      WHERE "strategyName" = 'llm-ollama' AND "modelName" = 'mistral'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET "modelName" = 'mistral'
      WHERE "strategyName" = 'llm-ollama' AND "modelName" = 'mistral-nemo'
    `);
  }
}
