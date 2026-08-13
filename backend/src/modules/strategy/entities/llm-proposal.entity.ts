import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
  JoinColumn,
} from "typeorm";
import { StrategyRun } from "./strategy-run.entity";
import { Guess } from "./guess.entity";

export enum LlmProposalStatus {
  USED = "used",
  REJECTED_DUPLICATE = "rejected_duplicate",
  NOT_SELECTED = "not_selected",
}

// Records every candidate group the LLM proposed across a solve step, not just
// the winner. promptNumber identifies which prompt within the solve step
// produced this group (1-based); guessNumber is the sequenceNumber of the guess
// the step produced (NULL when the step ended without a guess). A 'used' row is
// the proposal that became the guess and links to it via guessId; the guess's
// outcome (success/failure/offBy1/duplicate) lives on the linked record.
@Entity("LlmProposal")
@Index("IDX_LlmProposal_strategyRunId", ["strategyRunId"])
@Index("IDX_LlmProposal_guessId", ["guessId"])
export class LlmProposal {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int" })
  strategyRunId: number;

  @ManyToOne(() => StrategyRun, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "strategyRunId" })
  strategyRun: StrategyRun;

  @Column({ type: "int", nullable: true })
  guessId: number | null;

  // Nullable: a solve step can end (or be interrupted) without producing a guess
  @ManyToOne(() => Guess, { nullable: true, onDelete: "SET NULL" })
  @JoinColumn({ name: "guessId" })
  guess: Guess | null;

  @Column({ type: "int" })
  promptNumber: number;

  @Column({ type: "int", nullable: true })
  guessNumber: number | null;

  @Column({ type: "jsonb" })
  words: string[];

  @Column({ type: "text" })
  category: string;

  @Column({ type: "double precision" })
  confidence: number;

  @Column({ type: "text" })
  reasoning: string;

  @Column({
    type: "enum",
    enum: LlmProposalStatus,
    enumName: "llm_proposal_status_enum",
  })
  status: LlmProposalStatus;

  @CreateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  createdAt: Date;
}
