// Live backend client for the individual puzzle-run page — the first page in
// /leaderboard wired to the real /strategy API instead of the mock fixtures
// in mockData.ts. Kept separate from mockData.ts so it's obvious at a glance
// which parts of the benchmark UI are still mock-driven.

import type {
  FreeTierDispatchStatus,
  FreeTierId,
  FreeTierUsage,
  Leaderboard,
  RunHistory,
  RunHistorySortBy,
  RunHistorySortDir,
  RunRecord,
  StrategyRunDetail,
  StrategyRunListItem,
  SupportedModelRecord,
} from "./types";
import { computeDurationMs } from "./metrics";

const apiUrl = (path: string) => `${import.meta.env.VITE_API_URL}${path}`;

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(apiUrl(path), { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? `Request failed with status ${res.status}`);
  }
  return res.json();
}

/** Runs for one strategy + puzzle, keyed by the puzzle's numeric id (matches
 * the /leaderboard/:strategyId/:puzzleId route param). An empty array means
 * the strategy simply hasn't been run for this puzzle yet — not an error. */
export function fetchRunsForPuzzle(
  strategyName: string,
  puzzleId: number,
  signal?: AbortSignal,
): Promise<StrategyRunListItem[]> {
  return fetchJson(`/strategy/${strategyName}/puzzle-id/${puzzleId}`, signal);
}

/** Same run list as fetchRunsForPuzzle, keyed by the puzzle's date instead of
 * its numeric id — for callers (GuessSequencePanel) that only know the date
 * at fetch time. */
export function fetchRunsForStrategyDate(
  strategyName: string,
  date: string,
  signal?: AbortSignal,
): Promise<StrategyRunListItem[]> {
  return fetchJson(`/strategy/${strategyName}/puzzle/${date}`, signal);
}

/** The puzzle's date, keyed by its numeric id — lets pages that only know a
 * puzzleId (like the run page) link to the actual /puzzle/:date page. */
export async function fetchPuzzleDate(puzzleId: number, signal?: AbortSignal): Promise<string> {
  const { date } = await fetchJson<{ id: number; date: string }>(
    `/game/puzzle-id/${puzzleId}`,
    signal,
  );
  return date;
}

/** DB-driven leaderboard rows, split deterministic/shuffle vs LLM — only
 * strategies/models with at least one real run appear (see LeaderboardRow).
 * `progress.queued` on each row is read live from Redis by the backend, so
 * this is never cached client-side beyond the single fetch. */
export function fetchLeaderboard(signal?: AbortSignal): Promise<Leaderboard> {
  return fetchJson("/strategy/leaderboard", signal);
}

export interface FetchRunHistoryOptions {
  /** Narrows to one LLM model's runs; ignored server-side for non-LLM
   * strategies. */
  model?: string;
  page?: number;
  limit?: number;
  sortBy?: RunHistorySortBy;
  sortDir?: RunHistorySortDir;
}

/** Paginated, sortable history of every individual run for a strategy — one
 * row per run across every puzzle (unlike fetchRunsForPuzzle, which scopes to
 * one puzzle). Powers the /leaderboard/:strategyId run-history table. */
export function fetchRunHistory(
  strategyName: string,
  options: FetchRunHistoryOptions = {},
  signal?: AbortSignal,
): Promise<RunHistory> {
  const params = new URLSearchParams();
  if (options.model) params.set("model", options.model);
  if (options.page) params.set("page", String(options.page));
  if (options.limit) params.set("limit", String(options.limit));
  if (options.sortBy) params.set("sortBy", options.sortBy);
  if (options.sortDir) params.set("sortDir", options.sortDir);

  const query = params.toString();
  return fetchJson(`/strategy/${strategyName}/runs${query ? `?${query}` : ""}`, signal);
}

/** The real model allowlist (every configured model, any strategy). Used to
 * resolve a :strategyId route param the static mock catalog doesn't
 * recognize — e.g. a model added to the backend after the mock list was
 * last updated — rather than treating it as an unknown strategy outright. */
export function fetchSupportedModels(signal?: AbortSignal): Promise<SupportedModelRecord[]> {
  return fetchJson("/strategy/models", signal);
}

/** Today's spend against one of the two free-token programs — see
 * FreeTierId/FreeTierUsage. Backs the leaderboard page's budget widgets,
 * one instance per tier. */
export function fetchFreeTierUsage(tier: FreeTierId, signal?: AbortSignal): Promise<FreeTierUsage> {
  return fetchJson(`/strategy/free-tier-usage/${tier}`, signal);
}

/** Whether a continuous free-tier dispatch cycle is currently running for
 * `tier`, and at what threshold — see FreeTierDispatchStatus. Backs the
 * leaderboard budget widget's "auto-dispatch active" indicator. */
export function fetchFreeTierDispatchStatus(
  tier: FreeTierId,
  signal?: AbortSignal,
): Promise<FreeTierDispatchStatus> {
  return fetchJson(`/dispatch/free-tier/${tier}`, signal);
}

const DETAIL_PAGE_SIZE = 200;

/** Fetches every page of a paginated run-detail response and concatenates
 * their guesses. Page 1 is needed first to learn the total page count, but
 * the rest are fetched in parallel rather than one page-at-a-time — a
 * deterministic run can hold ~2,400 guesses (12 pages at DETAIL_PAGE_SIZE),
 * and awaiting each page sequentially before requesting the next turns that
 * into 12 serial round trips instead of 2. */
async function fetchAllRunDetailPages(
  fetchPage: (page: number) => Promise<StrategyRunDetail>,
): Promise<StrategyRunDetail> {
  const first = await fetchPage(1);
  const totalPages = Math.ceil(first.meta.total / first.meta.limit);
  if (totalPages <= 1) return first;

  const rest = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, i) => fetchPage(i + 2)),
  );

  return { ...first, guesses: [...first.guesses, ...rest.flatMap((page) => page.guesses)] };
}

/** Full detail for one run (guesses plus, for LLM strategies, the
 * reconstructed prompt/proposal chain), keyed by the run's own id. */
export function fetchRunDetail(runId: number, signal?: AbortSignal): Promise<StrategyRunDetail> {
  return fetchAllRunDetailPages((page) =>
    fetchJson<StrategyRunDetail>(`/strategy/run/${runId}?page=${page}&limit=${DETAIL_PAGE_SIZE}`, signal),
  );
}

/** Same detail payload as fetchRunDetail, keyed by (strategyName, date,
 * trialNumber) instead of runId — for GuessSequencePanel, which only knows
 * the puzzle date and strategy (not the run's id) at fetch time. */
export function fetchRunDetailByStrategyDate(
  strategyName: string,
  date: string,
  trialNumber: number,
  signal?: AbortSignal,
): Promise<StrategyRunDetail> {
  return fetchAllRunDetailPages((page) =>
    fetchJson<StrategyRunDetail>(
      `/strategy/${strategyName}/puzzle/${date}/run/${trialNumber}?page=${page}&limit=${DETAIL_PAGE_SIZE}`,
      signal,
    ),
  );
}

/** Adapts a live run-list item into the RunsTable component's existing
 * RunRecord shape (built against mockData's naming), so the table doesn't
 * need to change to consume live data. `totalSteps` is the run's actual
 * guess count regardless of outcome (unlike the mock, which only ever fills
 * it in for completed runs) — the real count is informative for
 * failed/duplicate runs too, and null only means "no guesses yet". */
export function toRunRecord(item: StrategyRunListItem): RunRecord {
  const durationMs = computeDurationMs(item.startedAt, item.finishedAt);

  return {
    runId: item.id,
    runNumber: item.trialNumber,
    status: item.status,
    totalSteps: item.guessCount,
    durationMs,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
    modelName: item.modelName,
  };
}
