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

export enum SolvePromptType {
  INITIAL_SOLVE = "initialSolve",
  RETRY = "retry",
}

export enum SolvePromptStatus {
  PARSED = "parsed",
  MALFORMED_NO_ANSWER_BLOCK = "malformedNoAnswerBlock",
  MALFORMED_GROUP_COUNT = "malformedGroupCount",
  MALFORMED_OTHER = "malformedOther",
  // The OpenAI call itself never produced usable model text — either an
  // earlier attempt this step's backend retry loop discarded, or the step's
  // own terminal failure. rawResponseText stays null for these rows; the
  // request/response/error columns below carry whatever raw detail the
  // orchestrator captured instead.
  CALL_ERROR = "callError",
}

// Records every prompt submitted during a multi-guess LLM solve step.
// Each button press in the AI Assist flow corresponds to one SolvePrompt:
// the FIRST is 'initialSolve', subsequent retries (after an incorrect or
// oneAway guess) are 'retry'.  Prompt-level telemetry (tokens, latency,
// temperature) lives here instead of on Guess, since a single solve step
// may produce multiple prompts.
@Entity("SolvePrompt")
@Index("IDX_SolvePrompt_strategyRunId", ["strategyRunId"])
export class SolvePrompt {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int" })
  strategyRunId: number;

  @ManyToOne(() => StrategyRun, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "strategyRunId" })
  strategyRun: StrategyRun;

  // 1-based sequence number within the solve step (1 = initial, 2+ = retries).
  @Column({ type: "int" })
  promptNumber: number;

  @Column({
    type: "enum",
    enum: SolvePromptType,
    enumName: "solve_prompt_type_enum",
  })
  promptType: SolvePromptType;

  @Column({
    type: "enum",
    enum: SolvePromptStatus,
    enumName: "solve_prompt_status_enum",
    default: SolvePromptStatus.PARSED,
  })
  status: SolvePromptStatus;

  @Column({ type: "text", nullable: true })
  rawResponseText: string | null;

  // True when at least one group's "Words:" line in this response had a
  // trailing parenthetical explanation glued onto it (e.g. "LOOK, TOUCH,
  // SIGHT, SMELL (these are all senses)") that the parser had to strip
  // before splitting on commas. rawResponseText always keeps the untouched
  // original text — this just flags that the parser had to work around it,
  // so a run that got stuck on this can be found later. See
  // llm-strategy-runner.service.ts's WORDS_PARENTHETICAL_RE.
  @Column({ type: "boolean", default: false })
  wordsHadParenthetical: boolean;

  // 1-based within promptNumber's step — distinguishes an OpenAI call the
  // backend had to retry (orchestrator.service.ts) from the step's other
  // attempts, all of which share the same promptNumber.
  @Column({ type: "int", default: 1 })
  attemptNumber: number;

  // ── Raw OpenAI call detail (populated on every attempt, not just the
  // step's eventual outcome — see llm-strategy-runner.service.ts) ────────

  @Column({ type: "jsonb", nullable: true })
  requestBody: unknown | null;

  @Column({ type: "text", nullable: true })
  responseId: string | null;

  @Column({ type: "jsonb", nullable: true })
  responseHeaders: Record<string, string> | null;

  @Column({ type: "jsonb", nullable: true })
  responseBody: unknown | null;

  @Column({ type: "int", nullable: true })
  statusCode: number | null;

  @Column({ type: "text", nullable: true })
  errorName: string | null;

  @Column({ type: "text", nullable: true })
  errorMessage: string | null;

  @Column({ type: "boolean", nullable: true })
  isRetryable: boolean | null;

  // ── Per-prompt LLM telemetry ────────────────────────────────────────

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
  createdAt: Date;
}
