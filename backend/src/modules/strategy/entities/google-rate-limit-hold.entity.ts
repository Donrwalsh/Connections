import { Entity, PrimaryGeneratedColumn, Column, Unique, Index } from "typeorm";

/**
 * One row per Google model currently held because it hit its free-tier
 * requests-per-day (RPD) quota. `resetAt` is the next America/Los_Angeles
 * midnight — after that instant the row is stale and the google-rpd-resume
 * sweep deletes it. `strategyName` is always "llm-google" today; it is kept
 * explicit so the table is not provider-locked. See
 * docs/superpowers/specs/2026-08-27-llm-google-rpd-hold-design.md.
 */
@Entity("GoogleRateLimitHold")
@Unique("UQ_GoogleRateLimitHold_strategyName_modelName", ["strategyName", "modelName"])
export class GoogleRateLimitHold {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text" })
  strategyName: string;

  @Column({ type: "text" })
  modelName: string;

  @Column({ type: "timestamptz" })
  heldAt: Date;

  @Index("IDX_GoogleRateLimitHold_resetAt")
  @Column({ type: "timestamptz" })
  resetAt: Date;
}
