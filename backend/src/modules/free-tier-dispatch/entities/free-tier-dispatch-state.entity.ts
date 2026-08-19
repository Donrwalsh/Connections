import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

// One row per free-tier program (see FreeTierUsageService's FreeTierId) —
// the authoritative record of whether its dispatch cycle is currently
// running and, if so, at what threshold. Deliberately not derived from
// BullMQ queue state: a self-rescheduling tick job has no single "job" that
// represents the whole cycle (each tick is its own job, chained via a fresh
// id — see FreeTierDispatchService), so this table is what both the status
// endpoint and each tick itself check to decide whether to keep going.
@Entity("FreeTierDispatchState")
export class FreeTierDispatchState {
  @PrimaryColumn({ type: "varchar" })
  tier: string;

  @Column({ type: "boolean", default: false })
  active: boolean;

  @Column({ type: "int" })
  thresholdPercent: number;

  @Column({ type: "timestamptz", nullable: true })
  startedAt: Date | null;

  @UpdateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt: Date;
}
