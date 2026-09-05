import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/**
 * Single-row table (id is always "mistral") tracking whether the Mistral
 * free-dispatch cycle (MistralFreeDispatchService) is currently running —
 * the Mistral counterpart to GroqDispatchState.
 */
@Entity("MistralDispatchState")
export class MistralDispatchState {
  @PrimaryColumn({ type: "varchar" })
  id: string;

  @Column({ type: "boolean", default: false })
  active: boolean;

  @Column({ type: "timestamptz", nullable: true })
  startedAt: Date | null;

  @UpdateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt: Date;
}
