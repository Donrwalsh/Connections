import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Single-row table tracking whether the Mistral free-dispatch cycle
 * (MistralFreeDispatchService) is currently running — the Mistral
 * counterpart to GroqDispatchState.
 */
export class AddMistralDispatchState1793000000000 implements MigrationInterface {
  name = "AddMistralDispatchState1793000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "MistralDispatchState" (
        "id" VARCHAR PRIMARY KEY,
        "active" BOOLEAN NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "MistralDispatchState"`);
  }
}
