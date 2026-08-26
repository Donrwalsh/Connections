import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backfills openRouterSlug for the remaining registered OpenAI models —
 * confirmed live on OpenRouter (GET /api/v1/models, non-zero pricing and
 * context_length present) as of this migration's authoring. Follows
 * 1771000000000-backfill-openrouter-slugs.ts's precedent: only mapped once
 * checked against the live API, never guessed.
 *
 * 'gpt-4.1-nano-2025-04-14' (a dated-snapshot registration with no matching
 * dated slug on OpenRouter — only the undated 'openai/gpt-4.1-nano' exists)
 * is deliberately left unmapped, per explicit decision, rather than reused
 * against a slug that isn't actually a match for its own identity.
 */
export class BackfillRemainingOpenRouterSlugs1772000000000 implements MigrationInterface {
  name = "BackfillRemainingOpenRouterSlugs1772000000000";

  private readonly mappings: Array<[modelName: string, slug: string]> = [
    ["gpt-4.1", "openai/gpt-4.1"],
    ["gpt-4.1-mini", "openai/gpt-4.1-mini"],
    ["gpt-4o", "openai/gpt-4o"],
    ["gpt-4o-mini", "openai/gpt-4o-mini"],
    ["gpt-5", "openai/gpt-5"],
    ["gpt-5.1", "openai/gpt-5.1"],
    ["gpt-5.2", "openai/gpt-5.2"],
    ["gpt-5.4", "openai/gpt-5.4"],
    ["gpt-5.4-mini", "openai/gpt-5.4-mini"],
    ["gpt-5.4-nano", "openai/gpt-5.4-nano"],
    ["gpt-5-mini", "openai/gpt-5-mini"],
    ["gpt-5-nano", "openai/gpt-5-nano"],
    ["o1", "openai/o1"],
    ["o3", "openai/o3"],
    ["o3-mini", "openai/o3-mini"],
    ["o4-mini", "openai/o4-mini"],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [modelName, slug] of this.mappings) {
      await queryRunner.query(
        `UPDATE "SupportedModel" SET "openRouterSlug" = $1
         WHERE "strategyName" = 'llm-openai' AND "modelName" = $2`,
        [slug, modelName],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const slugs = this.mappings.map(([, slug]) => slug);
    await queryRunner.query(
      `UPDATE "SupportedModel" SET "openRouterSlug" = NULL WHERE "openRouterSlug" = ANY($1)`,
      [slugs],
    );
  }
}
