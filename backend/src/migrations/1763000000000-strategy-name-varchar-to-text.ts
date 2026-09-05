import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * StrategyRun.strategyName/modelName and SupportedModel.strategyName/
 * modelName were `varchar` with no length constraint, buying nothing over
 * `text` while being inconsistent with sibling free-form columns
 * (AnswerGroup/GroupMember) that already use it. A bare `varchar` -> `text`
 * ALTER is metadata-only in Postgres (no rewrite, no length to validate).
 */
export class StrategyNameVarcharToText1763000000000 implements MigrationInterface {
  name = "StrategyNameVarcharToText1763000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "StrategyRun" ALTER COLUMN "strategyName" TYPE text`);
    await queryRunner.query(`ALTER TABLE "StrategyRun" ALTER COLUMN "modelName" TYPE text`);
    await queryRunner.query(`ALTER TABLE "SupportedModel" ALTER COLUMN "strategyName" TYPE text`);
    await queryRunner.query(`ALTER TABLE "SupportedModel" ALTER COLUMN "modelName" TYPE text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "SupportedModel" ALTER COLUMN "modelName" TYPE character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "SupportedModel" ALTER COLUMN "strategyName" TYPE character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "StrategyRun" ALTER COLUMN "modelName" TYPE character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "StrategyRun" ALTER COLUMN "strategyName" TYPE character varying`,
    );
  }
}
