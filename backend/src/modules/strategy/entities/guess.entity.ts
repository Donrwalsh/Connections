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
  DUPLICATE = "duplicate",
}

export enum GuessSource {
  USER = "user",
  STRATEGY = "strategy",
}

@Entity("Guess")
// Fast ordered replay for a given run. The actual DDL (schema.sql /
// InitialSchema migration) creates this as a covering index that also
// INCLUDEs "words"; TypeORM can't express INCLUDE clauses, so the index is
// declared only in the migration and not repeated here.
@Index("IDX_Guess_puzzleId", ["puzzleId"])
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

  // LLM telemetry (strategy guesses): token counts and round-trip latency
  // of the model call that produced this guess.
  @Column({ type: "int", nullable: true })
  promptTokens: number | null;

  @Column({ type: "int", nullable: true })
  completionTokens: number | null;

  @Column({ type: "int", nullable: true })
  latencyMs: number | null;

  // LLM strategy: free-form metadata (category, confidence, reasoning, and
  // the exact prompt sent to the model for this step).
  @Column({ type: "jsonb", nullable: true })
  llmDetails: Record<string, unknown> | null;

  @CreateDateColumn({
    type: "timestamptz",
    default: () => "CURRENT_TIMESTAMP",
  })
  guessedAt: Date;
}
