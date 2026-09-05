import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/**
 * Single-row table (id is always "groq") tracking whether the Groq
 * free-daily-quota dispatch cycle (GroqFreeDispatchService) is currently
 * running — the Groq counterpart to GoogleDispatchState: no thresholdPercent,
 * Groq enforces a requests-per-day cap of its own.
 */
@Entity("GroqDispatchState")
export class GroqDispatchState {
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
