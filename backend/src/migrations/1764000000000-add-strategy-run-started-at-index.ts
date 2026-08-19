import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backs the Activity page's recent-runs feed (GET /strategy/runs/recent),
 * an unfiltered "ORDER BY startedAt DESC LIMIT 100" across every strategy —
 * the existing (strategyName, startedAt) index can't serve that since it
 * leads with strategyName.
 */
export class AddStrategyRunStartedAtIndex1764000000000 implements MigrationInterface {
  name = "AddStrategyRunStartedAtIndex1764000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "IDX_StrategyRun_startedAt" ON "StrategyRun" ("startedAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_StrategyRun_startedAt"`);
  }
}
