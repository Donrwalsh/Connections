import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/** Outcome of one leg of the daily-automation chain — see
 * DailyAutomationService. "alreadyExhausted" only ever applies to the
 * Google/Groq burn legs (GoogleFreeDispatchService.start() /
 * GroqFreeDispatchService.start() check up front whether every model is
 * already RPD-held); the OpenAI mini-burn leg only ever reports "started",
 * "alreadyActive", or "error". */
export type AutomationLegOutcome = "started" | "alreadyActive" | "alreadyExhausted" | "error";

/**
 * One row per UTC calendar day (`date`, "YYYY-MM-DD"), upserted as each leg
 * of the daily-automation chain (judge dispatch, OpenAI mini/nano burn,
 * Google burn, Groq burn — see DailyAutomationService) reports its outcome.
 * This is the single source of truth the UI reads to answer "did today's
 * automatic run happen, and what did it do" — rather than inferring it from
 * three different subsystems' own live state. See
 * docs/superpowers/specs/2026-09-04-daily-free-tier-automation-design.md.
 */
@Entity("AutomationRunLog")
export class AutomationRunLog {
  @PrimaryColumn({ type: "varchar" })
  date: string;

  @Column({ type: "timestamptz" })
  triggeredAt: Date;

  @Column({ type: "int", nullable: true })
  judgeEnqueued: number | null;

  @Column({ type: "text", nullable: true })
  judgeError: string | null;

  @Column({ type: "varchar", nullable: true })
  miniBurnOutcome: AutomationLegOutcome | null;

  @Column({ type: "text", nullable: true })
  miniBurnMessage: string | null;

  @Column({ type: "varchar", nullable: true })
  googleBurnOutcome: AutomationLegOutcome | null;

  @Column({ type: "text", nullable: true })
  googleBurnMessage: string | null;

  @Column({ type: "varchar", nullable: true })
  groqBurnOutcome: AutomationLegOutcome | null;

  @Column({ type: "text", nullable: true })
  groqBurnMessage: string | null;

  @UpdateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt: Date;
}
