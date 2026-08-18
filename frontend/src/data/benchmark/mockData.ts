// Mock data for the benchmark UI. The backend aggregation endpoints do not
// exist yet, so these fixtures stand in for them. They are seeded and
// deterministic: the same query always returns the same rows, which keeps
// tests and screenshots stable.
//
// Swap the three getters for fetch calls when the real endpoints land — the
// component layer should not need to change shape.

import type {
  ProgressCounts,
  PuzzleBreakdown,
  RunRecord,
  RunStatus,
  StrategyAggregate,
  StrategyKind,
  StrategyMeta,
} from "./types";
import { isFailedStatus } from "./runStatus";

export const PUZZLE_COUNT = 12;
export const PUZZLE_START_DATE = "2025-01-01";

interface StrategyDef extends StrategyMeta {
  guessMean: number;
  guessSpread: number;
  /** Multiplier on the base 0.1 failure chance (deterministic = 0). */
  failMultiplier: number;
  durationMeanMs: number;
}

const STRATEGY_DEFS: StrategyDef[] = [
  {
    id: "alphabetical",
    name: "Alphabetical",
    kind: "deterministic",
    description: "Deterministic · tries words in alphabetical order",
    runsPerPuzzle: 1,
    strategyName: "alphabetical",
    guessMean: 3.2,
    guessSpread: 2.0,
    failMultiplier: 0,
    durationMeanMs: 12,
  },
  {
    id: "reverse-alphabetical",
    name: "Reverse-Alphabetical",
    kind: "deterministic",
    description: "Deterministic · tries words in reverse alphabetical order",
    runsPerPuzzle: 1,
    strategyName: "reverse-alphabetical",
    guessMean: 3.6,
    guessSpread: 2.2,
    failMultiplier: 0,
    durationMeanMs: 12,
  },
  {
    id: "order",
    name: "Order",
    kind: "deterministic",
    description: "Deterministic · follows the board's original order",
    runsPerPuzzle: 1,
    strategyName: "order",
    guessMean: 2.4,
    guessSpread: 1.4,
    failMultiplier: 0,
    durationMeanMs: 10,
  },
  {
    id: "reverse-order",
    name: "Reverse-Order",
    kind: "deterministic",
    description: "Deterministic · walks the board order backwards",
    runsPerPuzzle: 1,
    strategyName: "reverse-order",
    guessMean: 2.8,
    guessSpread: 1.6,
    failMultiplier: 0,
    durationMeanMs: 10,
  },
  {
    id: "shuffle-smart",
    name: "Shuffle-Smart",
    kind: "shuffle",
    description: "Shuffle · seeded smart re-ordering with pruning",
    runsPerPuzzle: 3,
    strategyName: "shuffle-smart",
    guessMean: 4.8,
    guessSpread: 2.4,
    failMultiplier: 0.7,
    durationMeanMs: 35,
  },
  {
    id: "shuffle-foolish",
    name: "Shuffle-Foolish",
    kind: "shuffle",
    description: "Shuffle · naive randomized re-ordering",
    runsPerPuzzle: 3,
    strategyName: "shuffle-foolish",
    guessMean: 6.8,
    guessSpread: 3.0,
    failMultiplier: 1.6,
    durationMeanMs: 42,
  },
  // LLM rows are keyed by *model*, not by the backend strategy that ran
  // them — several models can (and here, do) share the same underlying
  // "llm-openai"/"llm-ollama" strategy, so each gets its own leaderboard row
  // and /leaderboard/:id URL while `strategyName` still points at the
  // shared backend strategy for API calls (see StrategyMeta).
  {
    id: "gpt-4.1-nano-2025-04-14",
    name: "LLM · gpt-4.1-nano-2025-04-14",
    kind: "llm",
    description: "LLM-based · OpenAI gpt-4.1-nano proposes candidate groups",
    runsPerPuzzle: 3,
    strategyName: "llm-openai",
    guessMean: 4.2,
    guessSpread: 2.2,
    failMultiplier: 0.8,
    durationMeanMs: 26_000,
  },
  {
    id: "gpt-4o-mini",
    name: "LLM · gpt-4o-mini",
    kind: "llm",
    description: "LLM-based · OpenAI gpt-4o-mini proposes candidate groups",
    runsPerPuzzle: 3,
    strategyName: "llm-openai",
    guessMean: 3.8,
    guessSpread: 1.8,
    failMultiplier: 0.6,
    durationMeanMs: 18_000,
  },
  {
    id: "mistral",
    name: "LLM · mistral",
    kind: "llm",
    description: "LLM-based · Ollama mistral proposes candidate groups",
    runsPerPuzzle: 3,
    strategyName: "llm-ollama",
    guessMean: 4.6,
    guessSpread: 2.4,
    failMultiplier: 1.0,
    durationMeanMs: 30_000,
  },
  {
    id: "llama3.1-8b",
    name: "LLM · llama3.1:8b",
    kind: "llm",
    description: "LLM-based · Ollama llama3.1:8b proposes candidate groups",
    runsPerPuzzle: 3,
    strategyName: "llm-ollama",
    guessMean: 5.4,
    guessSpread: 2.6,
    failMultiplier: 1.3,
    durationMeanMs: 34_000,
  },
];

const KIND_PROFILE: Record<StrategyKind, { queuedRatio: number; runningRatio: number }> = {
  deterministic: { queuedRatio: 0, runningRatio: 0 },
  shuffle: { queuedRatio: 0.08, runningRatio: 0.05 },
  llm: { queuedRatio: 0.34, runningRatio: 0.06 },
};

/** Deterministic 32-bit string hash (FNV-1a) used to seed the PRNG. */
function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Small seeded PRNG (mulberry32) so generated fixtures are repeatable. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PUZZLE_DATES: string[] = Array.from({ length: PUZZLE_COUNT }, (_, index) => {
  const date = new Date(`${PUZZLE_START_DATE}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + index);
  return date.toISOString().slice(0, 10);
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDateLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${day}, ${year}`;
}

function modelFor(def: StrategyDef): string | null {
  // For "llm" kind rows, `id` already *is* the model name (see STRATEGY_DEFS).
  return def.kind === "llm" ? def.id : null;
}

interface GeneratedRun {
  runNumber: number;
  status: RunStatus;
  totalSteps: number | null;
  durationMs: number | null;
  modelName: string | null;
}

function generateRuns(def: StrategyDef, puzzleId: number): GeneratedRun[] {
  const rng = mulberry32(hashString(`${def.id}:${puzzleId}`));
  const profile = KIND_PROFILE[def.kind];
  const runs: GeneratedRun[] = [];

  for (let index = 0; index < def.runsPerPuzzle; index++) {
    const runNumber = def.kind === "deterministic" ? 0 : index + 1;

    if (rng() < profile.queuedRatio) {
      runs.push({
        runNumber,
        status: "queued",
        totalSteps: null,
        durationMs: null,
        modelName: null,
      });
      continue;
    }
    if (rng() < profile.runningRatio) {
      runs.push({
        runNumber,
        status: "running",
        totalSteps: null,
        durationMs: null,
        modelName: modelFor(def),
      });
      continue;
    }

    const failChance = 0.1 * def.failMultiplier;
    if (rng() < failChance) {
      const status: RunStatus =
        def.kind === "llm" && rng() < 0.4 ? "duplicate" : "failed";
      runs.push({
        runNumber,
        status,
        totalSteps: null,
        durationMs: null,
        modelName: modelFor(def),
      });
      continue;
    }

    const steps = Math.max(1, Math.round(def.guessMean + (rng() - 0.5) * 2 * def.guessSpread));
    const durationMs = Math.max(1, Math.round(def.durationMeanMs * (0.7 + rng() * 0.6)));
    runs.push({
      runNumber,
      status: "completed",
      totalSteps: steps,
      durationMs,
      modelName: modelFor(def),
    });
  }

  return runs;
}

/** Stable per-run id so the guess-chain visualizer can key on it. */
function runIdFor(def: StrategyDef, puzzleId: number, runIndex: number): number {
  return (hashString(def.id) % 10_000) * 1_000 + puzzleId * 10 + runIndex;
}

const runCache = new Map<string, GeneratedRun[]>();

function runsFor(def: StrategyDef, puzzleId: number): GeneratedRun[] {
  const key = `${def.id}:${puzzleId}`;
  const cached = runCache.get(key);
  if (cached) return cached;
  const runs = generateRuns(def, puzzleId);
  runCache.set(key, runs);
  return runs;
}

function requireDef(strategyId: string): StrategyDef {
  const def = STRATEGY_DEFS.find((candidate) => candidate.id === strategyId);
  if (!def) throw new Error(`Unknown strategy: ${strategyId}`);
  return def;
}

export function getStrategyMeta(strategyId: string): StrategyMeta | undefined {
  const def = STRATEGY_DEFS.find((candidate) => candidate.id === strategyId);
  if (!def) return undefined;
  return {
    id: def.id,
    name: def.name,
    kind: def.kind,
    description: def.description,
    runsPerPuzzle: def.runsPerPuzzle,
    strategyName: def.strategyName,
  };
}

export function getAllStrategyMeta(): StrategyMeta[] {
  return STRATEGY_DEFS.map((def) => ({
    id: def.id,
    name: def.name,
    kind: def.kind,
    description: def.description,
    runsPerPuzzle: def.runsPerPuzzle,
    strategyName: def.strategyName,
  }));
}

function bucketOf(status: RunStatus): keyof ProgressCounts {
  if (status === "queued") return "queued";
  if (status === "running") return "active";
  if (status === "completed") return "completed";
  return "failed";
}

/** Query 1: aggregate performance across all strategies (leaderboard rows). */
export function getStrategyAggregates(): StrategyAggregate[] {
  return STRATEGY_DEFS.map((def) => {
    const progress: ProgressCounts = { completed: 0, queued: 0, active: 0, failed: 0 };
    const guesses: number[] = [];
    let durationSum = 0;
    let durationCount = 0;

    for (let puzzleId = 1; puzzleId <= PUZZLE_COUNT; puzzleId++) {
      for (const run of runsFor(def, puzzleId)) {
        progress[bucketOf(run.status)]++;
        if (run.status === "completed") {
          guesses.push(run.totalSteps ?? 0);
          durationSum += run.durationMs ?? 0;
          durationCount++;
        }
      }
    }

    const finished = progress.completed + progress.failed;
    const sortedGuesses = [...guesses].sort((a, b) => a - b);

    return {
      id: def.id,
      name: def.name,
      kind: def.kind,
      description: def.description,
      runsPerPuzzle: def.runsPerPuzzle,
      strategyName: def.strategyName,
      totalPuzzles: PUZZLE_COUNT,
      expectedRuns: PUZZLE_COUNT * def.runsPerPuzzle,
      progress,
      successRate: finished === 0 ? null : (progress.completed / finished) * 100,
      avgGuessesToSolve:
        guesses.length === 0 ? null : guesses.reduce((a, b) => a + b, 0) / guesses.length,
      minGuesses: sortedGuesses[0] ?? null,
      maxGuesses: sortedGuesses[sortedGuesses.length - 1] ?? null,
      avgDurationMs: durationCount === 0 ? null : durationSum / durationCount,
    };
  });
}

export function getStrategyAggregate(strategyId: string): StrategyAggregate | undefined {
  return getStrategyAggregates().find((strategy) => strategy.id === strategyId);
}

/** Query 2: per-puzzle breakdown for a single strategy. */
export function getStrategyPuzzleBreakdown(strategyId: string): PuzzleBreakdown[] {
  const def = requireDef(strategyId);
  return PUZZLE_DATES.map((date, index) => {
    const puzzleId = index + 1;
    const runs = runsFor(def, puzzleId);
    const completedRuns = runs.filter((run) => run.status === "completed");
    const hasFailure = runs.some((run) => isFailedStatus(run.status));
    const guesses = completedRuns.map((run) => run.totalSteps ?? 0);

    return {
      puzzleId,
      date,
      label: formatDateLabel(date),
      runsPerPuzzle: def.runsPerPuzzle,
      completedRuns: completedRuns.length,
      status:
        completedRuns.length === runs.length
          ? "completed"
          : hasFailure
            ? "failed"
            : "in_progress",
      avgGuessesToSolve:
        guesses.length === 0 ? null : guesses.reduce((a, b) => a + b, 0) / guesses.length,
      minGuesses: guesses.length === 0 ? null : Math.min(...guesses),
      maxGuesses: guesses.length === 0 ? null : Math.max(...guesses),
    };
  });
}

export function getPuzzleBreakdown(
  strategyId: string,
  puzzleId: number,
): PuzzleBreakdown | undefined {
  return getStrategyPuzzleBreakdown(strategyId).find((puzzle) => puzzle.puzzleId === puzzleId);
}

/** Query 3: individual runs for one strategy + puzzle. */
export function getPuzzleRuns(strategyId: string, puzzleId: number): RunRecord[] {
  const def = requireDef(strategyId);
  const date = PUZZLE_DATES[puzzleId - 1];
  const startedAtBase = date ? new Date(`${date}T00:00:00Z`).getTime() : Date.now();

  return runsFor(def, puzzleId).map((run, index) => {
    const startedAt = new Date(startedAtBase + index * 60_000);
    const finishedAt =
      run.status === "queued" || run.status === "running"
        ? null
        : new Date(startedAt.getTime() + (run.durationMs ?? 0));
    return {
      runId: runIdFor(def, puzzleId, index),
      runNumber: run.runNumber,
      status: run.status,
      totalSteps: run.totalSteps,
      durationMs: run.durationMs,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt ? finishedAt.toISOString() : null,
      modelName: run.modelName,
    };
  });
}

export interface ProgressTotals {
  active: number;
  queued: number;
}

/** Totals for the leaderboard status strip (currently running / queued). */
export function summarizeProgress(strategies: StrategyAggregate[]): ProgressTotals {
  return strategies.reduce<ProgressTotals>(
    (totals, strategy) => ({
      active: totals.active + strategy.progress.active,
      queued: totals.queued + strategy.progress.queued,
    }),
    { active: 0, queued: 0 },
  );
}
