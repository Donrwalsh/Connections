import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from "typeorm";
import { SupportedModel } from "./supported-model.entity";

// Historical per-million-token pricing for a SupportedModel. Rows are
// immutable and append-only: when a provider changes its rate, a new row is
// inserted rather than an old one edited, so "the current price" for a model
// is always its most-recently-inserted row (highest id) — see
// SupportedModelService.findAll. cachedInputCostPerMillionTokens is
// deliberately not tracked; nothing in this project prices cached input
// tokens.
@Entity("ModelPrice")
@Index("IDX_ModelPrice_supportedModelId", ["supportedModelId"])
export class ModelPrice {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int" })
  supportedModelId: number;

  @ManyToOne(() => SupportedModel, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "supportedModelId" })
  supportedModel: SupportedModel;

  @Column({ type: "double precision" })
  inputCostPerMillionTokens: number;

  @Column({ type: "double precision" })
  outputCostPerMillionTokens: number;

  @CreateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt: Date;
}
