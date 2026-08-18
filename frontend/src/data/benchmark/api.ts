// Live backend client for the individual puzzle-run page — the first page in
// /leaderboard wired to the real /strategy API instead of the mock fixtures
// in mockData.ts. Kept separate from mockData.ts so it's obvious at a glance
// which parts of the benchmark UI are still mock-driven.

import type {
  Leaderboard,
  RunRecord,
  StrategyRunDetail,
  StrategyRunListItem,
  SupportedModelRecord,
} from "./types";

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

/** The real model allowlist (every configured model, any strategy). Used to
 * resolve a :strategyId route param the static mock catalog doesn't
 * recognize — e.g. a model added to the backend after the mock list was
 * last updated — rather than treating it as an unknown strategy outright. */
export function fetchSupportedModels(signal?: AbortSignal): Promise<SupportedModelRecord[]> {
  return fetchJson("/strategy/models", signal);
}

const DETAIL_PAGE_SIZE = 200;

/** Full detail for one run (guesses plus, for LLM strategies, the
 * reconstructed prompt/proposal chain), keyed by the run's own id. The
 * detail endpoint paginates guesses (a deterministic run can hold ~2,400), so
 * this fetches every page and concatenates them — mirroring
 * GuessSequencePanel's fetchFullRunDetail, the existing precedent for this
 * exact pagination shape. */
export async function fetchRunDetail(
  runId: number,
  signal?: AbortSignal,
): Promise<StrategyRunDetail> {
  const fetchPage = (page: number) =>
    fetchJson<StrategyRunDetail>(
      `/strategy/run/${runId}?page=${page}&limit=${DETAIL_PAGE_SIZE}`,
      signal,
    );

  const first = await fetchPage(1);
  const guesses = [...first.guesses];
  const totalPages = Math.ceil(first.meta.total / first.meta.limit);

  for (let page = 2; page <= totalPages; page++) {
    if (signal?.aborted) break;
    const next = await fetchPage(page);
    guesses.push(...next.guesses);
  }

  return { ...first, guesses };
}

/** Adapts a live run-list item into the RunsTable component's existing
 * RunRecord shape (built against mockData's naming), so the table doesn't
 * need to change to consume live data. `totalSteps` is the run's actual
 * guess count regardless of outcome (unlike the mock, which only ever fills
 * it in for completed runs) — the real count is informative for
 * failed/duplicate runs too, and null only means "no guesses yet". */
export function toRunRecord(item: StrategyRunListItem): RunRecord {
  const durationMs =
    item.finishedAt !== null
      ? new Date(item.finishedAt).getTime() - new Date(item.startedAt).getTime()
      : null;

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
