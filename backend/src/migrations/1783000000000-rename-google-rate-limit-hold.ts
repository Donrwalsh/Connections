import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Generalizes the Google-only rate-limit-hold table to the shared
 * RateLimitHold the rpd-resume sweep now uses for both llm-google and
 * llm-groq. Pure rename — the strategyName column was already explicit, so
 * no data is touched. See
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
export class RenameGoogleRateLimitHold1783000000000 implements MigrationInterface {
  name = "RenameGoogleRateLimitHold1783000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "GoogleRateLimitHold" RENAME TO "RateLimitHold"`);
    await queryRunner.query(
      `ALTER INDEX "IDX_GoogleRateLimitHold_resetAt" RENAME TO "IDX_RateLimitHold_resetAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "RateLimitHold" RENAME CONSTRAINT "UQ_GoogleRateLimitHold_strategyName_modelName"` +
        ` TO "UQ_RateLimitHold_strategyName_modelName"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "RateLimitHold" RENAME CONSTRAINT "UQ_RateLimitHold_strategyName_modelName"` +
        ` TO "UQ_GoogleRateLimitHold_strategyName_modelName"`,
    );
    await queryRunner.query(
      `ALTER INDEX "IDX_RateLimitHold_resetAt" RENAME TO "IDX_GoogleRateLimitHold_resetAt"`,
    );
    await queryRunner.query(`ALTER TABLE "RateLimitHold" RENAME TO "GoogleRateLimitHold"`);
  }
}
