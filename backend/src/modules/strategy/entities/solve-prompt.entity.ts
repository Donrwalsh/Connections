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
  // The OpenAI call itself never produced usable model text — either an
  // earlier attempt this step's backend retry loop discarded, or the step's
  // own terminal failure. rawResponseText stays null for these rows; the
  // request/response/error columns below carry whatever raw detail the
  // orchestrator captured instead.
  CALL_ERROR = "callError",
}

// Known SolvePrompt.issueTags values. Not a DB enum — issueTags is a plain
// text[] column specifically so a new tag can be added here without a
// migration. 'unclassified' is the deliberate exception: it's applied when
// a response fails in a way none of the other tags explain, so a genuinely
// new failure variety is still discoverable (query for it, read
// rawResponseText, decide whether it deserves its own named tag) instead of
// silently vanishing — see
// docs/superpowers/specs/2026-08-26-llm-failure-taxonomy-design.md.
export const SolvePromptIssueTag = {
  PARENTHETICAL_STRIPPED: "parentheticalStripped",
  GROUP_COUNT_OFF: "groupCountOff",
  WORD_NOT_ON_LIST: "wordNotOnList",
  UNCLASSIFIED: "unclassified",
} as const;

export type SolvePromptIssueTagValue =
  (typeof SolvePromptIssueTag)[keyof typeof SolvePromptIssueTag];

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

  // Every model-response quality issue detected for this prompt (a group's
  // "Words:" line needing a trailing parenthetical stripped, a group whose
  // word count came out wrong, a proposed word that was never part of the
  // puzzle, or 'unclassified' for a failure shape none of those name yet —
  // see SolvePromptIssueTag above). rawResponseText always keeps the
  // untouched original text regardless of what's flagged here. A response
  // can trip more than one at once, which is why this is a list rather than
  // a single status value. Detection lives in
  // llm-strategy-runner.service.ts's parseGroupsSection/evaluateProposals.
  @Column({ type: "text", array: true, default: () => "'{}'" })
  issueTags: string[];

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
