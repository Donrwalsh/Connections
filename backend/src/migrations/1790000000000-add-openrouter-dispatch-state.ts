import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Single-row table tracking whether the OpenRouter free-daily-budget
 * dispatch cycle is currently running — the OpenRouter counterpart to
 * GroqDispatchState.
 */
export class AddOpenRouterDispatchState1790000000000 implements MigrationInterface {
  name = "AddOpenRouterDispatchState1790000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "OpenRouterDispatchState" (
        "id" VARCHAR PRIMARY KEY,
        "active" BOOLEAN NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "OpenRouterDispatchState"`);
  }
}
