import { Entity, PrimaryGeneratedColumn, Column, Unique, Index } from "typeorm";

/**
 * The single source of truth for which LLM strategy pools are currently held
 * for exhausting a free-tier quota — the unification of the five former
 * per-provider tables (GoogleRateLimitHold, GroqRateLimitHold,
 * OpenRouterRateLimitHold, MistralRateLimitHold, SambaNovaRateLimitHold).
 *
 * `strategyName` is the discriminator ("llm-google", "llm-groq", …). Two hold
 * shapes coexist in the one table:
 *
 *   - per-model: one row per held (strategyName, modelName) — Google, Groq,
 *     Mistral, SambaNova. `reason` is null.
 *   - account-wide: one row per strategyName with `modelName` NULL — OpenRouter,
 *     whose free-tier caps are account-wide. `reason` is 'daily' or
 *     'per-minute-cooldown'.
 *
 * `heldAt` is written but never read — kept for forensics. `resetAt` is the
 * instant the hold lifts; the per-provider *RpdResumeService sweeps delete
 * rows once it passes. How `resetAt` is derived is provider-specific and lives
 * in the caller (LlmStrategyRunner), not here.
 *
 * Uniqueness: the composite UNIQUE (strategyName, modelName) covers per-model
 * rows. Postgres treats NULLs as distinct in a b-tree unique index, so it does
 * NOT constrain account-wide rows — a partial unique index
 * "UQ_RateLimitHold_strategy_account" (strategyName) WHERE modelName IS NULL
 * pins those to one row per strategy. Both are created by
 * 1798000000000-unify-rate-limit-hold.ts; the decorators below mirror them for
 * query metadata only (the schema is migration-managed, synchronize is off).
 */
@Entity("RateLimitHold")
@Unique("UQ_RateLimitHold_strategy_model", ["strategyName", "modelName"])
@Index("UQ_RateLimitHold_strategy_account", ["strategyName"], {
  unique: true,
  where: '"modelName" IS NULL',
})
@Index("IDX_RateLimitHold_strategy_resetAt", ["strategyName", "resetAt"])
@Index("IDX_RateLimitHold_resetAt", ["resetAt"])
export class RateLimitHold {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text" })
  strategyName: string;

  @Column({ type: "text", nullable: true })
  modelName: string | null;

  @Column({ type: "text", nullable: true })
  reason: string | null;

  @Column({ type: "timestamptz" })
  heldAt: Date;

  @Column({ type: "timestamptz" })
  resetAt: Date;
}
