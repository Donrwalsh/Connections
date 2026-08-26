import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds columns for per-model metadata sourced from OpenRouter's public API
 * (context window, best-effort parameter count, provider description,
 * release date) plus openRouterSlug (the manual mapping a refresh job
 * matches against) and metadataUpdatedAt (last successful refresh). All
 * nullable — a model with no mapping or no live OpenRouter match simply has
 * no data here, never a fabricated value.
 */
export class AddSupportedModelMetadataColumns1770000000000 implements MigrationInterface {
  name = "AddSupportedModelMetadataColumns1770000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SupportedModel"
        ADD COLUMN "openRouterSlug" TEXT NULL,
        ADD COLUMN "contextWindow" INT NULL,
        ADD COLUMN "paramCount" BIGINT NULL,
        ADD COLUMN "providerDescription" TEXT NULL,
        ADD COLUMN "releaseDate" TIMESTAMPTZ NULL,
        ADD COLUMN "metadataUpdatedAt" TIMESTAMPTZ NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SupportedModel"
        DROP COLUMN "openRouterSlug",
        DROP COLUMN "contextWindow",
        DROP COLUMN "paramCount",
        DROP COLUMN "providerDescription",
        DROP COLUMN "releaseDate",
        DROP COLUMN "metadataUpdatedAt"
    `);
  }
}
