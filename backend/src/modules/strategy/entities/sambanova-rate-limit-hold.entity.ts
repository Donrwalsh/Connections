import { Entity, PrimaryGeneratedColumn, Column, Unique } from "typeorm";

/**
 * The source of truth for which SambaNova models are currently held for
 * exhausting a free-tier per-day quota (requests-per-day or tokens-per-day).
 * One row per held (strategyName, modelName); SambaNovaRpdResumeService
 * clears rows whose resetAt has passed. A structural copy of
 * GroqRateLimitHold — SambaNova's free-tier caps are per-model, and its
 * rate-limit headers give a reset *duration* from the hit rather than a
 * shared reset clock, so resetAt is heldAt plus that hit's parsed reset
 * distance. See
 * docs/superpowers/specs/2026-09-05-sambanova-cloud-provider-design.md §3.
 */
@Entity("SambaNovaRateLimitHold")
@Unique("UQ_SambaNovaRateLimitHold_strategyName_modelName", ["strategyName", "modelName"])
export class SambaNovaRateLimitHold {
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
