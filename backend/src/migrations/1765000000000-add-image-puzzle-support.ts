import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backs image-based puzzle dates (NYT dates whose cards carry image_url/
 * image_alt_text instead of content) — is_image_puzzle records which dates
 * were irregular, image_url carries the per-card image reference alongside
 * the existing plain-text word column.
 */
export class AddImagePuzzleSupport1765000000000 implements MigrationInterface {
  name = "AddImagePuzzleSupport1765000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "Puzzle" ADD COLUMN "is_image_puzzle" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "GroupMember" ADD COLUMN "image_url" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "GroupMember" DROP COLUMN "image_url"`);
    await queryRunner.query(`ALTER TABLE "Puzzle" DROP COLUMN "is_image_puzzle"`);
  }
}
