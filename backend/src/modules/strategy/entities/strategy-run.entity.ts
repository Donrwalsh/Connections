import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  Unique,
  CreateDateColumn,
  UpdateDateColumn,
  JoinColumn,
} from "typeorm";
import { Puzzle } from "../../game/entities/puzzle.entity";
import { Guess } from "./guess.entity";

export enum StrategyRunStatus {
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
}

@Entity("StrategyRun")
@Unique("UQ_StrategyRun_puzzle_strategyName_trialNumber", [
  "puzzleId",
  "strategyName",
  "trialNumber",
])
export class StrategyRun {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int" })
  puzzleId: number;

  @ManyToOne(() => Puzzle, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "puzzleId" })
  puzzle: Puzzle;

  @Column({ type: "varchar" })
  strategyName: string;

  // Distinguishes multiple runs of the same strategy on one puzzle. Always 0
  // for deterministic strategies; 1..N for shuffle-smart/shuffle-foolish trials.
  @Column({ type: "int", default: 0 })
  trialNumber: number;

  @Column({
    type: "enum",
    enum: StrategyRunStatus,
    enumName: "strategy_run_status_enum",
    default: StrategyRunStatus.RUNNING,
  })
  status: StrategyRunStatus;

  // Sorted array of words not yet placed into a solved group
  @Column({ type: "jsonb" })
  availableWords: string[];

  // Indices into availableWords representing the last combination attempted
  @Column({ type: "jsonb" })
  currentCombination: number[];

  @OneToMany(() => Guess, (guess) => guess.strategyRun)
  guesses: Guess[];

  @CreateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  startedAt: Date;

  @UpdateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  updatedAt: Date;

  @Column({ type: "timestamptz", nullable: true })
  finishedAt: Date | null;
}
