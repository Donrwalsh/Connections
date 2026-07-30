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
@Unique("UQ_StrategyRun_puzzle_strategyName", ["puzzleId", "strategyName"])
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
