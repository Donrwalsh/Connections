import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * One row per free-tier program tracking whether its continuous dispatch
 * cycle (FreeTierDispatchService) is currently running and at what
 * threshold — see FreeTierDispatchState's entity comment for why this is a
 * table rather than derived from BullMQ queue state.
 */
export class AddFreeTierDispatchState1761000000000 implements MigrationInterface {
  name = "AddFreeTierDispatchState1761000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "FreeTierDispatchState" (
        "tier" VARCHAR PRIMARY KEY,
        "active" BOOLEAN NOT NULL DEFAULT false,
        "thresholdPercent" INT NOT NULL,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "FreeTierDispatchState"`);
  }
}
