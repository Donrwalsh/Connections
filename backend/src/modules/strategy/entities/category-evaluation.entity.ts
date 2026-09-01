import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
  JoinColumn,
} from "typeorm";
import { StrategyRun } from "./strategy-run.entity";
import { LlmProposal } from "./llm-proposal.entity";
import { AnswerGroup } from "../../game/entities/answer-group.entity";

// TypeScript string enums, mapped to the two Postgres enum types created in
// the migration (category_eval_verdict_enum, category_eval_status_enum).
export enum CategoryEvalVerdict {
  CORRECT = "correct",
  PARTIAL = "partial",
  LUCKY = "lucky",
}

export enum CategoryEvalStatus {
  // The judge call produced a usable verdict.
  JUDGED = "judged",
  // The judge call itself failed — verdict stays null; the error/request/
  // response columns carry whatever detail was captured. Mirrors
  // SolvePromptStatus.CALL_ERROR.
  CALL_ERROR = "callError",
}

/**
 * One LLM-judge verdict on whether a *successful* used LlmProposal named the
 * real connection (see AnswerGroup.group_name) or just landed the right four
 * words. Written entirely by the batch/queue evaluation path — see
 * category-evaluator.service.ts and
 * docs/superpowers/specs/2026-08-27-llm-category-accuracy-evaluation-design.md.
 *
 * The diagnostic columns below (judgeModel .. temperature) mirror
 * SolvePrompt's raw call-detail block so a specific verdict can be audited.
 */
@Entity("CategoryEvaluation")
@Index("IDX_CategoryEvaluation_strategyRunId", ["strategyRunId"])
@Index("UQ_CategoryEvaluation_llmProposalId", ["llmProposalId"], { unique: true })
export class CategoryEvaluation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int" })
  llmProposalId: number;

  @ManyToOne(() => LlmProposal, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "llmProposalId" })
  llmProposal: LlmProposal;

  // Denormalized so getLeaderboard can group verdict counts by run without
  // a three-table join — the same reason LlmProposal carries strategyRunId.
  @Column({ type: "int" })
  strategyRunId: number;

  @ManyToOne(() => StrategyRun, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "strategyRunId" })
  strategyRun: StrategyRun;

  @Column({ type: "int" })
  answerGroupId: number;

  @ManyToOne(() => AnswerGroup, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "answerGroupId" })
  answerGroup: AnswerGroup;

  @Column({
    type: "enum",
    enum: CategoryEvalVerdict,
    enumName: "category_eval_verdict_enum",
    nullable: true,
  })
  verdict: CategoryEvalVerdict | null;

  @Column({ type: "text", nullable: true })
  rationale: string | null;

  @Column({ type: "text" })
  proposedCategory: string;

  @Column({ type: "text" })
  actualCategory: string;

  @Column({
    type: "enum",
    enum: CategoryEvalStatus,
    enumName: "category_eval_status_enum",
    default: CategoryEvalStatus.JUDGED,
  })
  status: CategoryEvalStatus;

  @Column({ type: "int" })
  evaluatorVersion: number;

  // ── Judge-call diagnostics (mirrors SolvePrompt) ────────────────────

  @Column({ type: "text" })
  judgeModel: string;

  @Column({ type: "text" })
  judgeProvider: string;

  @Column({ type: "jsonb", nullable: true })
  requestBody: unknown | null;

  @Column({ type: "text", nullable: true })
  responseId: string | null;

  @Column({ type: "jsonb", nullable: true })
  responseHeaders: Record<string, string> | null;

  @Column({ type: "jsonb", nullable: true })
  responseBody: unknown | null;

  @Column({ type: "text", nullable: true })
  rawResponseText: string | null;

  @Column({ type: "int", nullable: true })
  statusCode: number | null;

  @Column({ type: "text", nullable: true })
  errorName: string | null;

  @Column({ type: "text", nullable: true })
  errorMessage: string | null;

  @Column({ type: "boolean", nullable: true })
  isRetryable: boolean | null;

  @Column({ type: "int", nullable: true })
  promptTokens: number | null;

  @Column({ type: "int", nullable: true })
  completionTokens: number | null;

  @Column({ type: "int", nullable: true })
  totalTokens: number | null;

  @Column({ type: "int", nullable: true })
  latencyMs: number | null;

  @Column({ type: "double precision", nullable: true })
  temperature: number | null;

  @CreateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  evaluatedAt: Date;
}
