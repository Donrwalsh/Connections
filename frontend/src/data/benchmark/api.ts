// Live backend client for the individual puzzle-run page — the first page in
// /leaderboard wired to the real /strategy API instead of the mock fixtures
// in mockData.ts. Kept separate from mockData.ts so it's obvious at a glance
// which parts of the benchmark UI are still mock-driven.

import type {
  AutomationStatus,
  CategoryEvaluationCoverage,
  DeleteRunResult,
  FreeTierDispatchBothStartResult,
  FreeTierDispatchBothStopResult,
  FreeTierDispatchStatus,
  FreeTierId,
  FreeTierUsage,
  GoogleDispatchStatus,
  Leaderboard,
  RecentActivityEvent,
  RunHistory,
  RunHistorySortBy,
  RunHistorySortDir,
  RunRecord,
  RunStatus,
  StrategyRunDetail,
  StrategyRunListItem,
  SupportedModelRecord,
} from "./types";
import { computeDurationMs } from "./metrics";

const apiUrl = (path: string) => `${import.meta.env.VITE_API_URL}${path}`;

async function fetchJson<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), { ...init, signal });
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
  /** Narrows to one run status. "queued" is accepted by the type but never
   * actually matches anything server-side — a StrategyRun row is only ever
   * inserted once a run has started, so "queued" never appears as a real
   * row status (see RunHistoryRow). */
  status?: RunStatus;
}

/** Paginated, sortable, filterable history of every individual run for a
 * strategy — one row per run across every puzzle (unlike fetchRunsForPuzzle,
 * which scopes to one puzzle). Powers the /leaderboard/:strategyId
 * run-history table. */
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
  if (options.status) params.set("status", options.status);

  const query = params.toString();
  return fetchJson(`/strategy/${strategyName}/runs${query ? `?${query}` : ""}`, signal);
}

/** The most recent activity across every strategy/model, newest first —
 * runs starting and category-judge verdicts landing, interleaved. Backs the
 * Activity page's live feed. Fixed at 100 events server-side, no pagination
 * (a rolling window, not a list to page through). */
export function fetchRecentActivity(signal?: AbortSignal): Promise<RecentActivityEvent[]> {
  return fetchJson("/strategy/activity/recent", signal);
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

/** How much of the category-judge backlog is done — see
 * CategoryEvaluationCoverage. Backs the Activity page's Category judging
 * widget; `pending` is what the next evaluate-categories dispatch enqueues. */
export function fetchCategoryEvaluationCoverage(
  signal?: AbortSignal,
): Promise<CategoryEvaluationCoverage> {
  return fetchJson("/category-evaluation/coverage", signal);
}

/** Starts a continuous free-tier dispatch cycle for one tier at
 * `thresholdPercent` (a whole number, 1-100). Rejects (thrown Error, message
 * from the backend) if a cycle for this tier is already running, or the
 * threshold is out of range — see FreeTierDispatchModal, which surfaces
 * that message directly. `password` is only checked by the backend in
 * production (DispatchAuthGuard) — harmless to send blank elsewhere. */
export function startFreeTierDispatch(
  tier: FreeTierId,
  thresholdPercent: number,
  password: string,
  signal?: AbortSignal,
): Promise<FreeTierDispatchStatus> {
  return fetchJson(`/dispatch/free-tier/${tier}?threshold=${thresholdPercent}`, signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

/** Starts both tiers at once, independently — unlike startFreeTierDispatch,
 * this never rejects outright: each tier's own success/failure is reported
 * in the returned FreeTierDispatchBothStartResult instead, so one tier
 * already running doesn't prevent the other from starting. */
export function startBothFreeTierDispatch(
  thresholdPercent: number,
  password: string,
  signal?: AbortSignal,
): Promise<FreeTierDispatchBothStartResult> {
  return fetchJson(`/dispatch/free-tier/both?threshold=${thresholdPercent}`, signal, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

/** Stops one tier's dispatch cycle — a no-op (not an error) if it wasn't
 * running. */
export function stopFreeTierDispatch(
  tier: FreeTierId,
  signal?: AbortSignal,
): Promise<FreeTierDispatchStatus> {
  return fetchJson(`/dispatch/free-tier/${tier}`, signal, { method: "DELETE" });
}

/** Stops both tiers' dispatch cycles at once. */
export function stopBothFreeTierDispatch(
  signal?: AbortSignal,
): Promise<FreeTierDispatchBothStopResult> {
  return fetchJson("/dispatch/free-tier/both", signal, { method: "DELETE" });
}

/** Today's daily-automation run — see AutomationStatus. Backs the
 * "Auto-run: ... · Next: ..." line on the mini FreeTierBudgetWidget,
 * CategoryJudgingWidget, and GoogleDispatchWidget. */
export function fetchAutomationStatus(signal?: AbortSignal): Promise<AutomationStatus> {
  return fetchJson("/automation/status", signal);
}

/** Whether the Google free-daily-quota dispatch cycle is currently running —
 * see GoogleDispatchStatus. Backs GoogleDispatchWidget's active/inactive
 * indicator, polled the same way fetchFreeTierDispatchStatus is. */
export function fetchGoogleDispatchStatus(signal?: AbortSignal): Promise<GoogleDispatchStatus> {
  return fetchJson("/dispatch/google", signal);
}

/** Stops the Google dispatch cycle — a no-op (not an error) if it wasn't
 * running. No password body, same as stopFreeTierDispatch. */
export function stopGoogleDispatch(signal?: AbortSignal): Promise<GoogleDispatchStatus> {
  return fetchJson("/dispatch/google", signal, { method: "DELETE" });
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

/** Permanently deletes a run and everything tied to it (guesses, solve
 * prompts, LLM proposals). Rejects (thrown Error, message from the backend)
 * if the run is still running, or doesn't exist. `password` is only checked
 * by the backend in production (DispatchAuthGuard) — harmless to send blank
 * elsewhere. */
export function deleteRun(
  runId: number,
  password: string,
  signal?: AbortSignal,
): Promise<DeleteRunResult> {
  return fetchJson(`/dispatch/run/${runId}`, signal, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
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
