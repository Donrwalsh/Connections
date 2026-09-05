import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Single-row table tracking whether the Groq free-daily-quota dispatch
 * cycle (GroqFreeDispatchService) is currently running — the Groq
 * counterpart to GoogleDispatchState, minus thresholdPercent (Groq has no
 * token budget, only a requests-per-day cap enforced by Groq itself).
 */
export class AddGroqDispatchState1785000000000 implements MigrationInterface {
  name = "AddGroqDispatchState1785000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "GroqDispatchState" (
        "id" VARCHAR PRIMARY KEY,
        "active" BOOLEAN NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "GroqDispatchState"`);
  }
}
