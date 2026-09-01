import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the CategoryEvaluation table — one LLM-judge verdict per successful
 * used LlmProposal on whether its proposed category named the real
 * connection. See
 * docs/superpowers/specs/2026-08-27-llm-category-accuracy-evaluation-design.md.
 * No data backfill: rows are produced by the evaluation jobs.
 */
export class AddCategoryEvaluation1776000000000 implements MigrationInterface {
  name = "AddCategoryEvaluation1776000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "category_eval_verdict_enum" AS ENUM ('correct', 'partial', 'lucky')`,
    );
    await queryRunner.query(
      `CREATE TYPE "category_eval_status_enum" AS ENUM ('judged', 'callError')`,
    );
    await queryRunner.query(`
      CREATE TABLE "CategoryEvaluation" (
        "id" SERIAL NOT NULL,
        "llmProposalId" integer NOT NULL,
        "strategyRunId" integer NOT NULL,
        "answerGroupId" integer NOT NULL,
        "verdict" "category_eval_verdict_enum",
        "rationale" text,
        "proposedCategory" text NOT NULL,
        "actualCategory" text NOT NULL,
        "status" "category_eval_status_enum" NOT NULL DEFAULT 'judged',
        "evaluatorVersion" integer NOT NULL,
        "judgeModel" text NOT NULL,
        "judgeProvider" text NOT NULL,
        "requestBody" jsonb,
        "responseId" text,
        "responseHeaders" jsonb,
        "responseBody" jsonb,
        "rawResponseText" text,
        "statusCode" integer,
        "errorName" text,
        "errorMessage" text,
        "isRetryable" boolean,
        "promptTokens" integer,
        "completionTokens" integer,
        "totalTokens" integer,
        "latencyMs" integer,
        "temperature" double precision,
        "evaluatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_CategoryEvaluation_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_CategoryEvaluation_llmProposalId" UNIQUE ("llmProposalId"),
        CONSTRAINT "FK_CategoryEvaluation_llmProposalId" FOREIGN KEY ("llmProposalId")
          REFERENCES "LlmProposal"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_CategoryEvaluation_strategyRunId" FOREIGN KEY ("strategyRunId")
          REFERENCES "StrategyRun"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_CategoryEvaluation_answerGroupId" FOREIGN KEY ("answerGroupId")
          REFERENCES "AnswerGroup"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_CategoryEvaluation_strategyRunId" ON "CategoryEvaluation" ("strategyRunId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "CategoryEvaluation"`);
    await queryRunner.query(`DROP TYPE "category_eval_status_enum"`);
    await queryRunner.query(`DROP TYPE "category_eval_verdict_enum"`);
  }
}
