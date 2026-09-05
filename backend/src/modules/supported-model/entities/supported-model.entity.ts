import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Unique,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

// Allowlist of models a strategy is permitted to dispatch runs against.
// `strategyName` is a plain string (not a foreign key) — it matches the same
// free-form identifier used on StrategyRun ("llm-openai"/"llm-ollama"), which
// isn't itself a DB-backed entity. A run is only ever dispatched for a model
// that has a row here with `supported = true`; see
// SupportedModelService.assertSupported. Pricing lives separately on
// ModelPrice (one model can have many price rows over time as rates change)
// — see that entity for why it's split out.
@Entity("SupportedModel")
@Unique("UQ_SupportedModel_strategyName_modelName", ["strategyName", "modelName"])
export class SupportedModel {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text" })
  strategyName: string;

  @Column({ type: "text" })
  modelName: string;

  @Column({ type: "boolean", default: true })
  supported: boolean;

  // Which free-tier program (see FreeTierId in
  // modules/strategy/free-tier-usage.service.ts) this model counts toward,
  // if any — null for a model that isn't part of either program. Editable
  // directly (e.g. via Adminer) with no redeploy required; the tier-level
  // token limits/labels stay as code constants (FREE_TIER_LIMITS) since
  // they're per-tier, not per-model.
  @Column({ type: "text", nullable: true })
  freeTier: string | null;

  // OpenRouter's model id, e.g. "openai/gpt-4.1-nano" — set manually per
  // model (same place a model is registered). null means "not mapped, skip
  // this row on refresh" — see ModelMetadataRefreshService.
  @Column({ type: "text", nullable: true })
  openRouterSlug: string | null;

  // When set, the model's ModelPrice rows must be sourced from this
  // provider's own endpoint pricing on OpenRouter rather than the model's
  // aggregate list pricing — e.g. "Groq" for models whose negotiated/reported
  // price differs by provider. null ("any") uses the list-level pricing. See
  // ModelMetadataRefreshService.maybeInsertNewPrice.
  @Column({ type: "text", nullable: true })
  priceScopeProvider: string | null;

  // From OpenRouter's context_length. Also used as the real per-model
  // context window for Ollama's num_ctx — see provider.ts.
  @Column({ type: "int", nullable: true })
  contextWindow: number | null;

  // Best-effort: parsed from the OpenRouter slug/name or description prose.
  // null for most OpenAI rows — OpenAI doesn't publish parameter counts.
  @Column({ type: "bigint", nullable: true })
  paramCount: number | null;

  // OpenRouter's own natural-language description of the model, verbatim.
  @Column({ type: "text", nullable: true })
  providerDescription: string | null;

  // From OpenRouter's created (Unix timestamp) — the model's real release
  // date, not just when OpenRouter listed it.
  @Column({ type: "timestamptz", nullable: true })
  releaseDate: Date | null;

  // Set on every successful refresh match; null until the first one.
  @Column({ type: "timestamptz", nullable: true })
  metadataUpdatedAt: Date | null;

  @CreateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt: Date;

  @UpdateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt: Date;
}
