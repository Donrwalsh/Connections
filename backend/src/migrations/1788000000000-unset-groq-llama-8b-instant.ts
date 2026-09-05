import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Marks the llm-groq model llama-3.1-8b-instant as unsupported. It was
 * seeded supported = true by 1787000000000-add-more-groq-models.ts on the
 * strength of Groq's public model list, but live calls against it return
 * HTTP 404 "The model `llama-3.1-8b-instant` does not exist or you do not
 * have access to it" — the model is gated to a Groq tier this deployment's
 * key does not have, so every trial the GroqFreeDispatchService cycle
 * dispatched against it burned to StrategyRunStatus.ERROR after the model
 * -error retry budget.
 *
 * Same operator lever as 1780000000000-unset-legacy-gemini-flash-support.ts
 * (documented in supported-model.service.ts): the row and its openRouterSlug
 * are kept so past runs still resolve on the leaderboard and a follow-up can
 * flip the flag back if access changes, but findModelNamesByStrategy filters
 * on supported = true, so dispatch stops touching it immediately.
 *
 * llama-3.3-70b-versatile is left supported — it has not shown the same
 * access error.
 */
export class UnsetGroqLlama8bInstant1788000000000 implements MigrationInterface {
  name = "UnsetGroqLlama8bInstant1788000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET supported = false
      WHERE "strategyName" = 'llm-groq'
        AND "modelName" = 'llama-3.1-8b-instant'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "SupportedModel"
      SET supported = true
      WHERE "strategyName" = 'llm-groq'
        AND "modelName" = 'llama-3.1-8b-instant'
    `);
  }
}
