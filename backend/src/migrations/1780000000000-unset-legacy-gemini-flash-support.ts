import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Marks the legacy llm-google Gemini Flash / Flash Lite models —
 * gemini-2.5-flash, gemini-2.5-flash-lite, and gemini-3-flash — as
 * unsupported so the daily Google free-quota burn cycle
 * (GoogleFreeDispatchService, driven by
 * SupportedModelService.findModelNamesByStrategy("llm-google")) no longer
 * dispatches trials against them. Rows and price history are kept so past
 * runs still resolve on the leaderboard. Matches the operator lever documented
 * in supported-model.service.ts ("a model that's since been marked
 * unsupported"). These rows were first registered by
 * 1776000000000-add-gemini-flash-models.ts.
 */
export class UnsetLegacyGeminiFlashSupport1780000000000 implements MigrationInterface {
  name = "UnsetLegacyGeminiFlashSupport1780000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET supported = false
      WHERE "strategyName" = 'llm-google'
        AND "modelName" IN ('gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET supported = true
      WHERE "strategyName" = 'llm-google'
        AND "modelName" IN ('gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash')
    `);
  }
}
