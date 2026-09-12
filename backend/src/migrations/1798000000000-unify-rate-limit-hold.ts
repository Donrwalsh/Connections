import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Unifies the five per-provider rate-limit hold tables — "GoogleRateLimitHold",
 * "GroqRateLimitHold", "OpenRouterRateLimitHold", "MistralRateLimitHold",
 * "SambaNovaRateLimitHold" — into one "RateLimitHold" table behind one
 * RateLimitHoldService.
 *
 * `strategyName` already discriminates the provider, so no pool column is
 * added here. `modelName` becomes nullable to hold OpenRouter's account-wide
 * row; a nullable `reason` carries OpenRouter's 'daily' / 'per-minute-cooldown'
 * distinction and is NULL for every per-model provider.
 *
 * Uniqueness: the composite UNIQUE (strategyName, modelName) covers per-model
 * rows. Postgres treats NULLs as distinct in a unique b-tree, so it does not
 * constrain the account-wide rows — the partial unique index
 * "UQ_RateLimitHold_strategy_account" pins those to one row per strategy.
 *
 * Live holds are copied across before the legacy tables are dropped; they
 * expire within ~24h, so a currently-parked run keeps its hold rather than
 * being revived early into a doomed provider call.
 */
export class UnifyRateLimitHold1798000000000 implements MigrationInterface {
  name = "UnifyRateLimitHold1798000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "RateLimitHold" (
        "id" SERIAL PRIMARY KEY,
        "strategyName" TEXT NOT NULL,
        "modelName" TEXT,
        "reason" TEXT,
        "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "UQ_RateLimitHold_strategy_model"
          UNIQUE ("strategyName", "modelName")
      )
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_RateLimitHold_strategy_account"
       ON "RateLimitHold" ("strategyName") WHERE "modelName" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_RateLimitHold_strategy_resetAt"
       ON "RateLimitHold" ("strategyName", "resetAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_RateLimitHold_resetAt"
       ON "RateLimitHold" ("resetAt")`,
    );

    // Per-model providers: modelName carries across, reason is NULL.
    for (const table of [
      "GoogleRateLimitHold",
      "GroqRateLimitHold",
      "MistralRateLimitHold",
      "SambaNovaRateLimitHold",
    ]) {
      await queryRunner.query(`
        INSERT INTO "RateLimitHold" ("strategyName", "modelName", "reason", "heldAt", "resetAt")
        SELECT "strategyName", "modelName", NULL, "heldAt", "resetAt" FROM "${table}"
        ON CONFLICT DO NOTHING
      `);
    }

    // OpenRouter: account-wide, no modelName column; carry its reason.
    await queryRunner.query(`
      INSERT INTO "RateLimitHold" ("strategyName", "modelName", "reason", "heldAt", "resetAt")
      SELECT "strategyName", NULL, "reason", "heldAt", "resetAt" FROM "OpenRouterRateLimitHold"
      ON CONFLICT DO NOTHING
    `);

    for (const table of [
      "GoogleRateLimitHold",
      "GroqRateLimitHold",
      "OpenRouterRateLimitHold",
      "MistralRateLimitHold",
      "SambaNovaRateLimitHold",
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Recreate the five legacy tables with their original DDL.
    for (const name of [
      "GoogleRateLimitHold",
      "GroqRateLimitHold",
      "MistralRateLimitHold",
      "SambaNovaRateLimitHold",
    ]) {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "${name}" (
          "id" SERIAL PRIMARY KEY,
          "strategyName" TEXT NOT NULL,
          "modelName" TEXT NOT NULL,
          "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
          "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
          CONSTRAINT "UQ_${name}_strategyName_modelName"
            UNIQUE ("strategyName", "modelName")
        )
      `);
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_${name}_resetAt" ON "${name}" ("resetAt")`,
      );
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "OpenRouterRateLimitHold" (
        "id" SERIAL PRIMARY KEY,
        "strategyName" TEXT NOT NULL,
        "heldAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "resetAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reason" TEXT NOT NULL,
        CONSTRAINT "UQ_OpenRouterRateLimitHold_strategyName" UNIQUE ("strategyName")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_OpenRouterRateLimitHold_resetAt"
       ON "OpenRouterRateLimitHold" ("resetAt")`,
    );

    // Copy live holds back, partitioned by strategyName.
    const perModel: Array<[string, string]> = [
      ["GoogleRateLimitHold", "llm-google"],
      ["GroqRateLimitHold", "llm-groq"],
      ["MistralRateLimitHold", "llm-mistral"],
      ["SambaNovaRateLimitHold", "llm-sambanova"],
    ];
    for (const [table, strategyName] of perModel) {
      await queryRunner.query(`
        INSERT INTO "${table}" ("strategyName", "modelName", "heldAt", "resetAt")
        SELECT "strategyName", "modelName", "heldAt", "resetAt"
        FROM "RateLimitHold"
        WHERE "strategyName" = '${strategyName}' AND "modelName" IS NOT NULL
        ON CONFLICT DO NOTHING
      `);
    }
    await queryRunner.query(`
      INSERT INTO "OpenRouterRateLimitHold" ("strategyName", "heldAt", "resetAt", "reason")
      SELECT "strategyName", "heldAt", "resetAt", COALESCE("reason", 'daily')
      FROM "RateLimitHold"
      WHERE "modelName" IS NULL
      ON CONFLICT DO NOTHING
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "RateLimitHold"`);
  }
}
