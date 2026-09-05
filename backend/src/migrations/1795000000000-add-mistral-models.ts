import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Registers four Mistral (La Plateforme) models for the llm-mistral
 * strategy: three small (mistral-small-latest, ministral-8b-latest,
 * ministral-3b-latest) plus one mid (mistral-medium-latest).
 *
 * Unlike Groq (where openRouterSlug was left NULL pending a live check),
 * the slugs here are set because they were confirmed live against
 * GET https://openrouter.ai/api/v1/models at implementation time — all four
 * advertise `response_format` + `structured_outputs`, which the app's
 * generateObject solve prompts need. `modelName` is Mistral's own La
 * Plateforme id; `openRouterSlug` is the separate OpenRouter-catalog
 * mapping ModelMetadataRefreshService uses to backfill contextWindow /
 * pricing / releaseDate.
 *
 * Deliberately excludes mistralai/mistral-small-3.1-24b-instruct (its
 * catalog row advertises no structured-output params) and every
 * OCR / audio (voxtral) / embedding / moderation / reasoning (magistral)
 * model — none produce plain structured solve output the way this app needs.
 *
 * mistral-medium-latest likely sits in a different Mistral free-tier pool
 * than the small models, with its own TPM / monthly token cap — irrelevant
 * to the code because this feature keeps no proactive budget; per-model
 * holds already isolate one pool's wall from the others.
 *
 * Trigger POST /dispatch/refresh-model-metadata once applied so
 * contextWindow / pricing aren't left blank until the next daily cron tick.
 * See docs/superpowers/specs/2026-09-05-mistral-la-plateforme-free-tier-design.md §8.
 */
export class AddMistralModels1795000000000 implements MigrationInterface {
  name = "AddMistralModels1795000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "SupportedModel" ("strategyName", "modelName", "supported", "openRouterSlug")
      VALUES
        ('llm-mistral', 'mistral-small-latest',  true, 'mistralai/mistral-small-3.2-24b-instruct'),
        ('llm-mistral', 'ministral-8b-latest',   true, 'mistralai/ministral-8b-2512'),
        ('llm-mistral', 'ministral-3b-latest',   true, 'mistralai/ministral-3b-2512'),
        ('llm-mistral', 'mistral-medium-latest', true, 'mistralai/mistral-medium-3.1')
      ON CONFLICT ("strategyName", "modelName") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "SupportedModel"
      WHERE "strategyName" = 'llm-mistral'
        AND "modelName" IN (
          'mistral-small-latest', 'ministral-8b-latest', 'ministral-3b-latest', 'mistral-medium-latest'
        )
    `);
  }
}
