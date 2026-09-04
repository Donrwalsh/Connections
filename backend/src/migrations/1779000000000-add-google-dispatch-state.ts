import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Single-row table tracking whether the Google free-daily-quota dispatch
 * cycle (GoogleFreeDispatchService) is currently running — the Google
 * counterpart to FreeTierDispatchState, minus thresholdPercent (Google has
 * no token budget, only a requests-per-day cap enforced by Google itself).
 */
export class AddGoogleDispatchState1779000000000 implements MigrationInterface {
  name = "AddGoogleDispatchState1779000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "GoogleDispatchState" (
        "id" VARCHAR PRIMARY KEY,
        "active" BOOLEAN NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "GoogleDispatchState"`);
  }
}
