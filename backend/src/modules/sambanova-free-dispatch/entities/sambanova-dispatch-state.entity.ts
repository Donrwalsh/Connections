import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/**
 * Single-row table (id is always "sambanova") tracking whether the
 * SambaNova free-tier dispatch cycle (SambaNovaFreeDispatchService) is
 * currently running — the SambaNova counterpart to GroqDispatchState.
 */
@Entity("SambaNovaDispatchState")
export class SambaNovaDispatchState {
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
