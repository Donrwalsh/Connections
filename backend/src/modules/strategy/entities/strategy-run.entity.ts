import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  Unique,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
  JoinColumn,
} from "typeorm";
import { Puzzle } from "../../game/entities/puzzle.entity";
import { Guess } from "./guess.entity";
import { SolvePrompt } from "./solve-prompt.entity";

export enum StrategyRunStatus {
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  DUPLICATE = "duplicate",
  MALFORMED_RESPONSE = "malformedResponse",
  ERROR = "error",
}

// Statuses that represent a terminal state (run will never resume).
export const TERMINAL_STATUSES: ReadonlySet<StrategyRunStatus> = new Set([
  StrategyRunStatus.COMPLETED,
  StrategyRunStatus.FAILED,
  StrategyRunStatus.DUPLICATE,
  StrategyRunStatus.MALFORMED_RESPONSE,
  StrategyRunStatus.ERROR,
]);

@Entity("StrategyRun")
@Unique("UQ_StrategyRun_puzzle_strategyName_trialNumber", [
  "puzzleId",
  "strategyName",
  "trialNumber",
])
// Backs countTodayDispatchByModel / countInFlightByModel's
// (strategyName, modelName [, startedAt]) filters, which run on every
// free-tier dispatch tick and would otherwise scan the whole table.
@Index("IDX_StrategyRun_strategyName_modelName", ["strategyName", "modelName"])
@Index("IDX_StrategyRun_strategyName_startedAt", ["strategyName", "startedAt"])
// Backs getRecentRuns' unfiltered "ORDER BY startedAt DESC LIMIT 100" — the
// two composite indexes above both lead with strategyName, so neither can
// serve a global (cross-strategy) sort on startedAt alone.
@Index("IDX_StrategyRun_startedAt", ["startedAt"])
export class StrategyRun {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "int" })
  puzzleId: number;

  @ManyToOne(() => Puzzle, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn({ name: "puzzleId" })
  puzzle: Puzzle;

  @Column({ type: "text" })
  strategyName: string;

  // Distinguishes multiple runs of the same strategy on one puzzle. Always 0
  // for deterministic strategies; 1..N for shuffle-smart/shuffle-foolish and
  // llm trials.
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

  // LLM strategy: the model that produced this run's guesses (e.g. "mistral")
  @Column({ type: "text", nullable: true })
  modelName: string | null;

  // LLM strategy: context window of the model in tokens
  @Column({ type: "int", nullable: true })
  contextWindow: number | null;

  @OneToMany(() => Guess, (guess) => guess.strategyRun)
  guesses: Guess[];

  @OneToMany(() => SolvePrompt, (prompt) => prompt.strategyRun)
  solvePrompts: SolvePrompt[];

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
