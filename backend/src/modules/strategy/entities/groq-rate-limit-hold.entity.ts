import { Entity, PrimaryGeneratedColumn, Column, Unique } from "typeorm";

/**
 * The source of truth for which Groq models are currently held for
 * exhausting their free-tier requests-per-day quota. One row per held
 * (strategyName, modelName); GroqRpdResumeService clears rows whose resetAt
 * has passed. Unlike GoogleRateLimitHold, resetAt is not a fixed daily
 * clock boundary — it's heldAt plus that hit's own reset-duration header
 * (see GroqRateLimitHoldService.hold), since Groq's rate-limit headers give
 * a countdown from the hit rather than a shared reset clock. See
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Entity("GroqRateLimitHold")
@Unique("UQ_GroqRateLimitHold_strategyName_modelName", ["strategyName", "modelName"])
export class GroqRateLimitHold {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text" })
  strategyName: string;

  @Column({ type: "text" })
  modelName: string;

  @Column({ type: "timestamptz" })
  heldAt: Date;

  @Column({ type: "timestamptz" })
  resetAt: Date;
}
