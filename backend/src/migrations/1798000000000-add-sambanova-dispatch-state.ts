import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Single-row table tracking whether the SambaNova free-tier dispatch cycle
 * (SambaNovaFreeDispatchService) is currently running — the SambaNova
 * counterpart to GroqDispatchState.
 */
export class AddSambaNovaDispatchState1798000000000 implements MigrationInterface {
  name = "AddSambaNovaDispatchState1798000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "SambaNovaDispatchState" (
        "id" VARCHAR PRIMARY KEY,
        "active" BOOLEAN NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "SambaNovaDispatchState"`);
  }
}
