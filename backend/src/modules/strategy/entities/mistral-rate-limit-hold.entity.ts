import { Entity, PrimaryGeneratedColumn, Column, Unique } from "typeorm";

/**
 * The source of truth for which Mistral models are currently held for a
 * rate-limit / monthly-quota hit. One row per held (strategyName,
 * modelName); MistralRpdResumeService clears rows whose resetAt has passed.
 * Identical in shape to GroqRateLimitHold — but resetAt is a short fixed
 * fallback (heldAt + MISTRAL_MODEL_HOLD_FALLBACK_SECONDS), not a per-hit
 * header duration: Mistral's free tier sends no rate-limit headers, so
 * there is no reset countdown to honour, and a short park the resume sweep
 * re-checks is the design. See
 * docs/superpowers/specs/2026-09-05-mistral-la-plateforme-free-tier-design.md §3.
 */
@Entity("MistralRateLimitHold")
@Unique("UQ_MistralRateLimitHold_strategyName_modelName", ["strategyName", "modelName"])
export class MistralRateLimitHold {
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
