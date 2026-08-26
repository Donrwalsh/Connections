// Static strategy/model display copy for the benchmark UI (name, kind,
// description). The backend has no general "strategy catalog" — every
// numeric/aggregate query is now live (see api.ts) — so this module is only
// a lookup table of UI copy, keyed the same way the live data is: a model
// name for "llm" kind rows, the strategy name itself otherwise. An id this
// table doesn't recognize (e.g. a model added to the backend after this list
// was last updated) falls back to a synthesized label — see
// describeLeaderboardRow and useStrategyMeta's buildDynamicMeta.

import { formatModelStatsDescription } from "./formatModelStats";
import type { LeaderboardRow, StrategyMeta } from "./types";

const STRATEGY_DEFS: StrategyMeta[] = [
  {
    id: "alphabetical",
    name: "Alphabetical",
    kind: "deterministic",
    description: "Deterministic · tries words in alphabetical order",
    runsPerPuzzle: 1,
    strategyName: "alphabetical",
  },
  {
    id: "reverse-alphabetical",
    name: "Reverse-Alphabetical",
    kind: "deterministic",
    description: "Deterministic · tries words in reverse alphabetical order",
    runsPerPuzzle: 1,
    strategyName: "reverse-alphabetical",
  },
  {
    id: "order",
    name: "Order",
    kind: "deterministic",
    description: "Deterministic · follows the board's original order",
    runsPerPuzzle: 1,
    strategyName: "order",
  },
  {
    id: "reverse-order",
    name: "Reverse-Order",
    kind: "deterministic",
    description: "Deterministic · walks the board order backwards",
    runsPerPuzzle: 1,
    strategyName: "reverse-order",
  },
  {
    id: "shuffle-smart",
    name: "Shuffle-Smart",
    kind: "shuffle",
    description: "Shuffle · seeded smart re-ordering with pruning",
    runsPerPuzzle: 3,
    strategyName: "shuffle-smart",
  },
  {
    id: "shuffle-foolish",
    name: "Shuffle-Foolish",
    kind: "shuffle",
    description: "Shuffle · naive randomized re-ordering",
    runsPerPuzzle: 3,
    strategyName: "shuffle-foolish",
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
    description: "OpenAI gpt-4.1-nano proposes candidate groups",
    runsPerPuzzle: 3,
    strategyName: "llm-openai",
  },
  {
    id: "gpt-4o-mini",
    name: "LLM · gpt-4o-mini",
    kind: "llm",
    description: "OpenAI gpt-4o-mini proposes candidate groups",
    runsPerPuzzle: 3,
    strategyName: "llm-openai",
  },
  {
    id: "mistral",
    name: "LLM · mistral",
    kind: "llm",
    description: "Ollama mistral proposes candidate groups",
    runsPerPuzzle: 3,
    strategyName: "llm-ollama",
  },
  {
    id: "llama3.1-8b",
    name: "LLM · llama3.1:8b",
    kind: "llm",
    description: "Ollama llama3.1:8b proposes candidate groups",
    runsPerPuzzle: 3,
    strategyName: "llm-ollama",
  },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDateLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${day}, ${year}`;
}

export function getStrategyMeta(strategyId: string): StrategyMeta | undefined {
  return STRATEGY_DEFS.find((candidate) => candidate.id === strategyId);
}

export function humanizeStrategyName(strategyName: string): string {
  return strategyName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("-");
}

/** Resolves display name/description for a live GET /strategy/leaderboard
 * row. The backend has no strategy-catalog concept — a LeaderboardRow is
 * pure run data — so this prefers the static catalog above (matched by
 * row.id, same id convention as StrategyMeta: a model name for LLM rows, the
 * strategy name otherwise) and falls back to a synthesized label for
 * anything the catalog doesn't recognize yet (e.g. a model added to the
 * backend after this list was last updated), mirroring useStrategyMeta's
 * buildDynamicMeta fallback for that same gap. */
export function describeLeaderboardRow(row: LeaderboardRow): { name: string; description: string } {
  const meta = getStrategyMeta(row.id);

  if (row.kind === "llm") {
    const providerLabel =
      row.strategyName === "llm-ollama"
        ? "Ollama"
        : row.strategyName === "llm-google"
          ? "Google"
          : "OpenAI";
    return {
      name: meta?.name ?? `LLM · ${row.modelName}`,
      description: formatModelStatsDescription(
        providerLabel,
        row.modelName ?? row.id,
        row.contextWindow,
        row.paramCount,
      ),
    };
  }

  if (meta) return { name: meta.name, description: meta.description };

  return {
    name: humanizeStrategyName(row.strategyName),
    description: `Strategy · ${row.strategyName}`,
  };
}
