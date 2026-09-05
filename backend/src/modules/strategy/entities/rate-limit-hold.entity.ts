import { Entity, PrimaryGeneratedColumn, Column, Unique, Index } from "typeorm";

/**
 * One row per model currently held because it hit its provider's free-tier
 * requests-per-day (RPD) quota. `resetAt` is that strategy's next quota
 * reset instant (Pacific midnight for llm-google, UTC midnight for
 * llm-groq) — after that instant the row is stale and the rpd-resume sweep
 * deletes it. `strategyName` keeps the table shared across providers. See
 * docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md and
 * docs/superpowers/specs/2026-09-04-groq-free-tier-design.md.
 */
@Entity("RateLimitHold")
@Unique("UQ_RateLimitHold_strategyName_modelName", ["strategyName", "modelName"])
export class RateLimitHold {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text" })
  strategyName: string;

  @Column({ type: "text" })
  modelName: string;

  @Column({ type: "timestamptz" })
  heldAt: Date;

  @Index("IDX_RateLimitHold_resetAt")
  @Column({ type: "timestamptz" })
  resetAt: Date;
}
