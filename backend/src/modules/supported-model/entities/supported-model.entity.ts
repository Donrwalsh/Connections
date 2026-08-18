import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Unique,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

// Allowlist of models a strategy is permitted to dispatch runs against, plus
// the cost data needed to price a run. `strategyName` is a plain string (not
// a foreign key) — it matches the same free-form identifier used on
// StrategyRun ("llm-openai"/"llm-ollama"), which isn't itself a DB-backed
// entity. A run is only ever dispatched for a model that has a row here with
// `supported = true`; see SupportedModelService.assertSupported.
@Entity("SupportedModel")
@Unique("UQ_SupportedModel_strategyName_modelName", ["strategyName", "modelName"])
export class SupportedModel {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar" })
  strategyName: string;

  @Column({ type: "varchar" })
  modelName: string;

  @Column({ type: "double precision" })
  inputCostPerMillionTokens: number;

  @Column({ type: "double precision" })
  cachedInputCostPerMillionTokens: number;

  @Column({ type: "double precision" })
  outputCostPerMillionTokens: number;

  @Column({ type: "boolean", default: true })
  supported: boolean;

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
