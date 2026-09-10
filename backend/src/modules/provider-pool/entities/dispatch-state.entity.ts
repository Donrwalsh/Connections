import { Entity, PrimaryColumn, Column, UpdateDateColumn } from "typeorm";

/**
 * One row per free-tier provider pool (`id` is the pool id: "google",
 * "groq", "openrouter", "mistral", "sambanova"), tracking whether that
 * pool's background free-dispatch cycle (`FreeDispatchService`) is currently
 * running. Replaces the five per-provider `*DispatchState` single-row tables
 * unified by the `unify-dispatch-state` migration.
 */
@Entity("DispatchState")
export class DispatchState {
  /** The provider-pool id. */
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
