import { Entity, PrimaryGeneratedColumn, Column, Unique } from "typeorm";

/**
 * The source of truth for whether the whole llm-openrouter strategy is
 * currently held. Unlike GoogleRateLimitHold / GroqRateLimitHold, this is
 * NOT per-model — OpenRouter's free-tier caps (20 req/min, 50-or-1000
 * req/day) are account-wide, so a single row per strategyName covers it.
 * `reason` is 'daily' (the account-wide requests-per-day quota is spent,
 * resetAt = next UTC midnight) or 'per-minute-cooldown' (a short global
 * backoff the runner writes after a 20 RPM 429 — see
 * OpenRouterFreeDispatchService). OpenRouterRpdResumeService clears the row
 * once resetAt passes. See
 * docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §3.
 */
@Entity("OpenRouterRateLimitHold")
@Unique("UQ_OpenRouterRateLimitHold_strategyName", ["strategyName"])
export class OpenRouterRateLimitHold {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text" })
  strategyName: string;

  @Column({ type: "timestamptz" })
  heldAt: Date;

  @Column({ type: "timestamptz" })
  resetAt: Date;

  @Column({ type: "text" })
  reason: "daily" | "per-minute-cooldown";
}
