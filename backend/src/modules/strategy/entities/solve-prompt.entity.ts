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
