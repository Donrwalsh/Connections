import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/**
 * Single-row table (id is always "openrouter") tracking whether the
 * OpenRouter free-daily-budget dispatch cycle
 * (OpenRouterFreeDispatchService) is currently running — the OpenRouter
 * counterpart to GroqDispatchState.
 */
@Entity("OpenRouterDispatchState")
export class OpenRouterDispatchState {
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
