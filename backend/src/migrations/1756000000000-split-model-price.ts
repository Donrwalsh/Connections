import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Splits SupportedModel's per-model pricing out into its own table,
 * ModelPrice, which allows multiple price rows per model (one provider rate
 * change no longer requires overwriting history — see ModelPrice's entity
 * comment). cachedInputCostPerMillionTokens is dropped entirely: nothing in
 * this project prices cached input tokens.
 *
 * Existing SupportedModel rows keep their id/strategyName/modelName/
 * supported; their current cost values are copied into one ModelPrice row
 * each before the cost columns are dropped from SupportedModel, so no
 * pricing data is lost.
 */
export class SplitModelPrice1756000000000 implements MigrationInterface {
  name = "SplitModelPrice1756000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ModelPrice" (
        "id" INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "supportedModelId" INT NOT NULL REFERENCES "SupportedModel"("id") ON DELETE CASCADE,
        "inputCostPerMillionTokens" DOUBLE PRECISION NOT NULL,
        "outputCostPerMillionTokens" DOUBLE PRECISION NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ModelPrice_supportedModelId"
        ON "ModelPrice" ("supportedModelId")
    `);

    // Carry forward whatever SupportedModel currently has, not the original
    // seed values — a deployment may have already updated rates by the time
    // this migration runs.
    await queryRunner.query(`
      INSERT INTO "ModelPrice"
        ("supportedModelId", "inputCostPerMillionTokens", "outputCostPerMillionTokens")
      SELECT "id", "inputCostPerMillionTokens", "outputCostPerMillionTokens"
      FROM "SupportedModel"
    `);

    await queryRunner.query(`ALTER TABLE "SupportedModel" DROP COLUMN "inputCostPerMillionTokens"`);
    await queryRunner.query(
      `ALTER TABLE "SupportedModel" DROP COLUMN "cachedInputCostPerMillionTokens"`,
    );
    await queryRunner.query(
      `ALTER TABLE "SupportedModel" DROP COLUMN "outputCostPerMillionTokens"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "SupportedModel" ADD COLUMN "inputCostPerMillionTokens" DOUBLE PRECISION`,
    );
    await queryRunner.query(
      `ALTER TABLE "SupportedModel" ADD COLUMN "cachedInputCostPerMillionTokens" DOUBLE PRECISION`,
    );
    await queryRunner.query(
      `ALTER TABLE "SupportedModel" ADD COLUMN "outputCostPerMillionTokens" DOUBLE PRECISION`,
    );

    // Backfill from each model's most recent price row. There's no data to
    // restore cachedInputCostPerMillionTokens from — it defaults to 0.
    await queryRunner.query(`
      UPDATE "SupportedModel" sm
      SET "inputCostPerMillionTokens" = latest."inputCostPerMillionTokens",
          "cachedInputCostPerMillionTokens" = 0,
          "outputCostPerMillionTokens" = latest."outputCostPerMillionTokens"
      FROM (
        SELECT DISTINCT ON ("supportedModelId")
          "supportedModelId", "inputCostPerMillionTokens", "outputCostPerMillionTokens"
        FROM "ModelPrice"
        ORDER BY "supportedModelId", "id" DESC
      ) latest
      WHERE sm."id" = latest."supportedModelId"
    `);
    await queryRunner.query(
      `UPDATE "SupportedModel" SET "inputCostPerMillionTokens" = 0 WHERE "inputCostPerMillionTokens" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "SupportedModel" SET "outputCostPerMillionTokens" = 0 WHERE "outputCostPerMillionTokens" IS NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "SupportedModel" ALTER COLUMN "inputCostPerMillionTokens" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "SupportedModel" ALTER COLUMN "cachedInputCostPerMillionTokens" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "SupportedModel" ALTER COLUMN "outputCostPerMillionTokens" SET NOT NULL`,
    );

    await queryRunner.query(`DROP TABLE IF EXISTS "ModelPrice"`);
  }
}
