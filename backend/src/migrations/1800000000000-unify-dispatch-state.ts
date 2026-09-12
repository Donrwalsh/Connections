import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Collapses the five per-provider single-row dispatch-state tables
 * (`GoogleDispatchState`, `GroqDispatchState`, `OpenRouterDispatchState`,
 * `MistralDispatchState`, `SambaNovaDispatchState`) into one `DispatchState`
 * table with one row per pool (`id` = the pool id).
 *
 * Drop-and-recreate, no row copy: dispatch state is ephemeral (`active` /
 * `startedAt`, rebuilt by the next tick). Worst case is a dispatch leg that
 * was mid-cycle at deploy time being re-evaluated on its next scheduled
 * tick. `down()` recreates the five old tables empty.
 */
export class UnifyDispatchState1800000000000 implements MigrationInterface {
  name = "UnifyDispatchState1800000000000";

  private static readonly OLD_TABLES = [
    "GoogleDispatchState",
    "GroqDispatchState",
    "OpenRouterDispatchState",
    "MistralDispatchState",
    "SambaNovaDispatchState",
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of UnifyDispatchState1800000000000.OLD_TABLES) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "DispatchState" (
        "id" VARCHAR PRIMARY KEY,
        "active" BOOLEAN NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "DispatchState"`);

    for (const table of UnifyDispatchState1800000000000.OLD_TABLES) {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "${table}" (
          "id" VARCHAR PRIMARY KEY,
          "active" BOOLEAN NOT NULL DEFAULT false,
          "startedAt" TIMESTAMP WITH TIME ZONE,
          "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
  }
}
