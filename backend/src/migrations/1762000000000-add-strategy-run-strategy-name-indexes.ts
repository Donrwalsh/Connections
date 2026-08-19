import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * StrategyRun's only existing constraint leads with puzzleId, so it can't
 * serve the strategyName(+modelName/startedAt)-only filters used by
 * countTodayDispatchByModel/countInFlightByModel (run on every free-tier
 * dispatch tick) and getRunHistory, which were falling back to sequential
 * scans.
 */
export class AddStrategyRunStrategyNameIndexes1762000000000 implements MigrationInterface {
  name = "AddStrategyRunStrategyNameIndexes1762000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX "IDX_StrategyRun_strategyName_modelName"
        ON "StrategyRun" ("strategyName", "modelName")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_StrategyRun_strategyName_startedAt"
        ON "StrategyRun" ("strategyName", "startedAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_StrategyRun_strategyName_startedAt"`);
    await queryRunner.query(`DROP INDEX "IDX_StrategyRun_strategyName_modelName"`);
  }
}
