import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers six NVIDIA NIM (build.nvidia.com) models for the llm-nvidia
 * strategy. The originally-researched candidates
 * (meta/llama-3.3-70b-instruct, mistralai/mixtral-8x22b-instruct-v0.1) turned
 * out to be genuinely dead — live calls returned HTTP 410 Gone with explicit
 * end-of-life dates (2026-08-26 and 2026-05-21), despite no deprecation
 * notice being found in documentation-era research. A live probe of this
 * account's full NIM catalog (GET /v1/models, 81 entries, ~50 plausible
 * chat/instruct candidates after filtering out embedding/vision/
 * classifier models) found these 6 actually callable with working
 * structured output — NVIDIA Build's per-account model entitlements are a
 * real, specific allowlist, not a single account-wide toggle and not
 * "every catalog-listed model works".
 *
 * `modelName` is NIM's own model id; `openRouterSlug` is the separate
 * OpenRouter-catalog mapping ModelMetadataRefreshService uses to backfill
 * contextWindow / pricing / releaseDate. gemma-4-31b-it reuses the slug
 * already confirmed for SambaNova's identical model
 * (1796000000000-add-sambanova-models.ts); gpt-oss-20b's slug is inferred
 * from that same migration's gpt-oss-120b row using its own model id as its
 * OpenRouter slug verbatim (same publisher/family, one size down) rather
 * than an independent OpenRouter lookup. The four NVIDIA-exclusive/NIM-tuned
 * models have no confirmed OpenRouter match and are left NULL; they stay
 * metadata-blank until a match is confirmed or added to OpenRouter later. No
 * ModelPrice row is inserted for any of the six, matching the Groq/Mistral/
 * SambaNova convention of letting ModelMetadataRefreshService backfill real
 * per-token pricing asynchronously.
 *
 * This app relies exclusively on generateObject (structured output only), so
 * `supported` requires a real response_format probe per model, not
 * documentation alone. All six passed a live generateObject probe.
 * nemotron-3-nano-omni-30b-a3b-reasoning's probe validated against the
 * schema but its answer field's content looked slightly off (extra text
 * bled in alongside the answer) — worth extra scrutiny once real
 * puzzle-solving traffic hits it; flip it to supported = false if it proves
 * unreliable in practice rather than guessing now.
 *
 * llm-nvidia is seeded but NOT part of PROVIDER_POOLS' free-tier automation
 * (its pool row has freeTier: null) — dispatch is manual only until NIM's
 * real-world rate-limit behavior is understood.
 *
 * Trigger POST /dispatch/refresh-model-metadata once applied so
 * contextWindow / pricing aren't left blank until the next daily cron tick.
 * See docs/specs/2026-09-21-nvidia-nim-provider-design.md.
 */
export class AddNvidiaModels1803000000000 implements MigrationInterface {
  name = "AddNvidiaModels1803000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
      VALUES
        ('llm-nvidia', 'nvidia/nemotron-3-ultra-550b-a55b',              true, NULL),
        ('llm-nvidia', 'nvidia/nemotron-3-super-120b-a12b',              true, NULL),
        ('llm-nvidia', 'mistralai/mistral-nemotron',                    true, NULL),
        ('llm-nvidia', 'google/gemma-4-31b-it',                         true, 'google/gemma-4-31b-it'),
        ('llm-nvidia', 'openai/gpt-oss-20b',                            true, 'openai/gpt-oss-20b'),
        ('llm-nvidia', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', true, NULL)
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-nvidia'
        AND "modelName" IN (
          'nvidia/nemotron-3-ultra-550b-a55b',
          'nvidia/nemotron-3-super-120b-a12b',
          'mistralai/mistral-nemotron',
          'google/gemma-4-31b-it',
          'openai/gpt-oss-20b',
          'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'
        )
    `);
  }
}
