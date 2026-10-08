import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export type FreeTierReservationStatus = "pending" | "unrecorded";

// One row per in-progress (or unaccounted-for) llm-openai call made by a
// free-tier-dispatched run — its worst-case token cost, held against the
// tier's threshold until the call's real usage is recorded. A 'pending'
// row is deleted in the same transaction that writes the call's SolvePrompt
// row; a call that failed without reporting usage flips to 'unrecorded' and
// keeps counting (OpenAI may still have billed it). Only rows created today
// (UTC) count, so nothing ever needs cleaning up. See FreeTierBudgetService.
@Entity("FreeTierReservation")
@Index("IDX_FreeTierReservation_tier_createdAt", ["tier", "createdAt"])
export class FreeTierReservation {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar" })
  tier: string;

  @Column({ type: "int" })
  strategyRunId: number;

  @Column({ type: "int" })
  reservedTokens: number;

  @Column({ type: "varchar", default: "pending" })
  status: FreeTierReservationStatus;

  @CreateDateColumn({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;
}
