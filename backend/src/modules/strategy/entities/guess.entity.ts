import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  Index,
  CreateDateColumn,
  JoinColumn,
} from "typeorm";
import { Puzzle } from "../../game/entities/puzzle.entity";
import { StrategyRun } from "./strategy-run.entity";

export enum GuessResult {
  SUCCESS = "success",
  FAILURE = "failure",
  OFF_BY_ONE = "offBy1",
}

export enum GuessSource {
  USER = "user",
  STRATEGY = "strategy",
}

@Entity("Guess")
@Index(["strategyRunId", "sequenceNumber"]) // Fast ordered replay for a given run
export class Guess {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int" })
  puzzleId: number;

  @ManyToOne(() => Puzzle, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "puzzleId" })
  puzzle: Puzzle;

  @Column({ type: "int", nullable: true })
  strategyRunId: number | null;

  // Nullable: human guesses via /game/guess won't have a strategyRun
  @ManyToOne(() => StrategyRun, (run) => run.guesses, {
    nullable: true,
    onDelete: "SET NULL",
  })
  @JoinColumn({ name: "strategyRunId" })
  strategyRun: StrategyRun | null;

  @Column({ type: "jsonb" })
  words: string[];

  @Column({
    type: "enum",
    enum: GuessResult,
    enumName: "guess_result_enum",
  })
  result: GuessResult;

  @Column({ type: "int" })
  sequenceNumber: number;

  @Column({
    type: "enum",
    enum: GuessSource,
    enumName: "guess_source_enum",
  })
  source: GuessSource;

  @CreateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  guessedAt: Date;
}
