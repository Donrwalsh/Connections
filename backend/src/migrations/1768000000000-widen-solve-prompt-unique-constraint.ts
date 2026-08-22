import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Widens SolvePrompt's original UNIQUE (strategyRunId, promptNumber)
 * constraint (from 1754400000000-initial-schema.ts) to include
 * attemptNumber. That original constraint predates attemptNumber and
 * assumed exactly one row per (run, promptNumber) — an assumption
 * 1767000000000-add-solve-prompt-call-detail.ts's attemptNumber column
 * broke on purpose: a single solve step can now write one CALL_ERROR row
 * per failed-and-retried OpenAI call attempt plus the step's own final
 * row, all sharing one promptNumber. Every one of those inserts a distinct
 * attemptNumber, so folding it into the constraint keeps duplicate-row
 * protection while allowing the multi-row-per-step shape the feature
 * actually needs.
 */
export class WidenSolvePromptUniqueConstraint1768000000000 implements MigrationInterface {
  name = "WidenSolvePromptUniqueConstraint1768000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      DROP CONSTRAINT "UQ_SolvePrompt_run_promptNumber"
    `);
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      ADD CONSTRAINT "UQ_SolvePrompt_run_promptNumber_attempt"
      UNIQUE ("strategyRunId", "promptNumber", "attemptNumber")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      DROP CONSTRAINT "UQ_SolvePrompt_run_promptNumber_attempt"
    `);
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      ADD CONSTRAINT "UQ_SolvePrompt_run_promptNumber"
      UNIQUE ("strategyRunId", "promptNumber")
    `);
  }
}
