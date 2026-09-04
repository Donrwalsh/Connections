import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/**
 * Single-row table (id is always "google") tracking whether the Google
 * free-daily-quota dispatch cycle (GoogleFreeDispatchService) is currently
 * running — the Google counterpart to FreeTierDispatchState, minus
 * thresholdPercent: Google has no token budget to compare a percentage
 * against, only a requests-per-day cap enforced by Google itself.
 */
@Entity("GoogleDispatchState")
export class GoogleDispatchState {
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
