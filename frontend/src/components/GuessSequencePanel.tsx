import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

type GuessResult = "success" | "failure" | "offBy1" | "duplicate";

interface Guess {
  sequenceNumber: number;
  words: string[];
  result: GuessResult;
  guessedAt: string;
}

interface StrategyRunListItem {
  id: number;
  strategyName: string;
  trialNumber: number;
  status:
    | "running"
    | "completed"
    | "failed"
    | "duplicate"
    | "malformedResponse"
    | "error";
  modelName: string | null;
  contextWindow: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  guessCount: number;
}

interface StrategyRunDetail extends StrategyRunListItem {
  guesses: Guess[];
  meta: { total: number; page: number; limit: number };
}

interface GuessSequencePanelProps {
  date: string;
  puzzleId: number;
  isOpen: boolean;
  onToggle: () => void;
}

const DETAIL_PAGE_SIZE = 200;

// The run detail endpoint is paginated (a deterministic run can hold ~2,400
// guesses), so the panel fetches every page and concatenates them to preserve
// the old "show the whole sequence" behavior.
async function fetchFullRunDetail(
  strategyName: string,
  date: string,
  trialNumber: number,
  signal: AbortSignal,
): Promise<StrategyRunDetail> {
  const fetchPage = async (page: number): Promise<StrategyRunDetail> => {
    const res = await fetch(
      apiUrl(
        `/strategy/${strategyName}/puzzle/${date}/run/${trialNumber}?page=${page}&limit=${DETAIL_PAGE_SIZE}`,
      ),
      { signal },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(
        body?.message ?? `Request failed with status ${res.status}`,
      );
    }
    return res.json();
  };

  const first = await fetchPage(1);
  const guesses = [...first.guesses];
  const totalPages = Math.ceil(first.meta.total / first.meta.limit);

  for (let page = 2; page <= totalPages; page++) {
    if (signal.aborted) break;
    const next = await fetchPage(page);
    guesses.push(...next.guesses);
  }

  return { ...first, guesses };
}

const STRATEGIES = [
  { id: "alphabetical", label: "Alphabetical" },
  { id: "reverse-alphabetical", label: "Rev-Alphabetical" },
  { id: "order", label: "Order" },
  { id: "reverse-order", label: "Rev-Order" },
  { id: "shuffle-smart", label: "Shuffle-Smart" },
  { id: "shuffle-foolish", label: "Shuffle-Foolish" },
  { id: "llm-openai", label: "LLM · OpenAI" },
  { id: "llm-ollama", label: "LLM · Ollama" },
];
const apiUrl = (path: string) => `${import.meta.env.VITE_API_URL}${path}`;

export function GuessSequencePanel({
  date,
  puzzleId,
  isOpen,
  onToggle,
}: GuessSequencePanelProps) {
  const [activeStrategy, setActiveStrategy] = useState<string>("alphabetical");

  const [strategyRuns, setStrategyRuns] = useState<
    Record<string, StrategyRunListItem[]>
  >({});
  const [loadingStrategies, setLoadingStrategies] = useState<
    Record<string, boolean>
  >({});
  const [errorMessages, setErrorMessages] = useState<Record<string, string>>(
    {},
  );
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  // Per-run detail is fetched lazily when a run is selected (full guess arrays
  // are heavy — a deterministic run can hold ~2,400 guesses), then cached.
  const [runDetails, setRunDetails] = useState<
    Record<number, StrategyRunDetail>
  >({});
  const [detailLoading, setDetailLoading] = useState<Record<number, boolean>>(
    {},
  );
  const [detailErrors, setDetailErrors] = useState<Record<number, string>>({});

  // Fetch strategy run lists on mount (or date change), regardless of isOpen
  // state. The list is deliberately slim (no guess arrays) so six strategies
  // load in a single parallel round of small requests.
  useEffect(() => {
    if (!date) return;

    const controller = new AbortController();

    setRunDetails({});
    setDetailLoading({});
    setDetailErrors({});
    setActiveRunId(null);

    const fetchStrategy = async (strategyId: string) => {
      setLoadingStrategies((prev) => ({ ...prev, [strategyId]: true }));
      setErrorMessages((prev) => ({ ...prev, [strategyId]: "" }));

      try {
        const res = await fetch(
          apiUrl(`/strategy/${strategyId}/puzzle/${date}`),
          { signal: controller.signal },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            body?.message ?? `Request failed with status ${res.status}`,
          );
        }
        const runs: StrategyRunListItem[] = await res.json();
        if (!controller.signal.aborted) {
          setStrategyRuns((prev) => ({ ...prev, [strategyId]: runs }));
        }
      } catch (err: unknown) {
        if (
          (err as Error)?.name !== "AbortError" &&
          !controller.signal.aborted
        ) {
          setErrorMessages((prev) => ({
            ...prev,
            [strategyId]:
              err instanceof Error ? err.message : "Failed to load strategy",
          }));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadingStrategies((prev) => ({ ...prev, [strategyId]: false }));
        }
      }
    };

    STRATEGIES.forEach((strat) => fetchStrategy(strat.id));

    return () => controller.abort();
  }, [date]); // Triggered as soon as date is passed down

  const currentRuns = strategyRuns[activeStrategy] ?? [];
  const selectedRun =
    currentRuns.find((run) => run.id === activeRunId) ?? currentRuns[0] ?? null;

  const selectedDetail = selectedRun ? runDetails[selectedRun.id] : undefined;
  const selectedDetailLoading = selectedRun
    ? detailLoading[selectedRun.id]
    : false;
  const selectedDetailError = selectedRun
    ? detailErrors[selectedRun.id]
    : undefined;

  // Ids whose detail is already fetched/cached, so the effect below skips them
  // without reading state it would otherwise have to declare as a dependency.
  const fetchedRunIds = useRef<Set<number>>(new Set());

  // Lazy-load the full guess list for the selected run, but only while the
  // panel is open. Fetches are cached per run and aborted on unmount/switch.
  useEffect(() => {
    if (!isOpen || !date || !selectedRun) return;
    if (fetchedRunIds.current.has(selectedRun.id)) return;

    const controller = new AbortController();
    setDetailLoading((prev) => ({ ...prev, [selectedRun.id]: true }));
    setDetailErrors((prev) => ({ ...prev, [selectedRun.id]: "" }));

    fetchFullRunDetail(
      selectedRun.strategyName,
      date,
      selectedRun.trialNumber,
      controller.signal,
    )
      .then((detail: StrategyRunDetail) => {
        if (!controller.signal.aborted) {
          setRunDetails((prev) => ({ ...prev, [selectedRun.id]: detail }));
          fetchedRunIds.current.add(selectedRun.id);
        }
      })
      .catch((err: unknown) => {
        if (
          (err as Error)?.name !== "AbortError" &&
          !controller.signal.aborted
        ) {
          setDetailErrors((prev) => ({
            ...prev,
            [selectedRun.id]:
              err instanceof Error ? err.message : "Failed to load run detail",
          }));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDetailLoading((prev) => ({ ...prev, [selectedRun.id]: false }));
        }
      });

    return () => controller.abort();
  }, [isOpen, date, selectedRun]);

  const handleStrategyClick = (strategyId: string) => {
    if (isOpen && activeStrategy === strategyId) {
      onToggle();
    } else {
      if (strategyId !== activeStrategy) {
        setActiveRunId(null);
      }
      setActiveStrategy(strategyId);
      if (!isOpen) {
        onToggle();
      }
    }
  };

  const isLoadingCurrent = loadingStrategies[activeStrategy];
  const currentError = errorMessages[activeStrategy];

  const averageGuesses = (runs: StrategyRunListItem[]) => {
    if (runs.length === 0) return null;
    const total = runs.reduce((sum, run) => sum + run.guessCount, 0);
    const average = total / runs.length;
    return Number.isInteger(average) ? String(average) : average.toFixed(1);
  };

  return (
    <section className="guess-sequence">
      <div className="guess-sequence__header-actions">
        {STRATEGIES.map((strat) => {
          const isActive = isOpen && activeStrategy === strat.id;
          const runs = strategyRuns[strat.id];
          const isLoading = loadingStrategies[strat.id];
          const stepCount = runs ? averageGuesses(runs) : null;

          return (
            <button
              key={strat.id}
              type="button"
              className={`guess-sequence__toggle ${
                isActive ? "guess-sequence__toggle--active" : ""
              }`}
              onClick={() => handleStrategyClick(strat.id)}
              aria-expanded={isActive}
            >
              {isActive ? "Hide" : "Show"} {strat.label}
              {stepCount !== null
                ? ` (${stepCount})`
                : isLoading
                  ? " (...)"
                  : ""}
            </button>
          );
        })}
      </div>

      {isOpen && (
        <div className="guess-sequence__content">
          {isLoadingCurrent && (
            <p>Loading {formatStrategyName(activeStrategy)} guesses...</p>
          )}

          {currentError && (
            <p className="guess-sequence__error">{currentError}</p>
          )}

          {!isLoadingCurrent && !currentError && currentRuns.length === 0 && (
            <p className="guess-sequence__empty">
              No runs yet for {formatStrategyName(activeStrategy)}.
            </p>
          )}

          {selectedRun && (
            <>
              {currentRuns.length > 1 && (
                <div className="guess-sequence__trials">
                  {currentRuns.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      className={`guess-sequence__trial ${
                        run.id === selectedRun.id
                          ? "guess-sequence__trial--active"
                          : ""
                      }`}
                      onClick={() => setActiveRunId(run.id)}
                    >
                      Trial #{run.trialNumber} · {run.status} · {run.guessCount}{" "}
                      guess
                      {run.guessCount === 1 ? "" : "es"}
                      {formatModelDetail(run)
                        ? ` · ${formatModelDetail(run)}`
                        : ""}
                    </button>
                  ))}
                </div>
              )}

              <p className="guess-sequence__status">
                Strategy: {formatStrategyName(selectedRun.strategyName)}
                {formatModelDetail(selectedRun)
                  ? ` · Model: ${formatModelDetail(selectedRun)}`
                  : ""}
                {currentRuns.length > 1
                  ? ` · Trial #${selectedRun.trialNumber}`
                  : ""}{" "}
                · Status: {selectedRun.status} · {selectedRun.guessCount} guess
                {selectedRun.guessCount === 1 ? "" : "es"}
              </p>

              {/* LLM runs only — deterministic/shuffle strategies never set
               * modelName. Full guess-by-guess detail (prompts, candidate
               * proposals, telemetry) now lives on the Puzzle Runs Page
               * instead of dropping down inline here. Guard puzzleId too: a
               * stale-cached /game/puzzle/:date response (from before this
               * field existed) would otherwise produce a link to
               * ".../undefined" — see PuzzlePage's fetch. */}
              {selectedRun.modelName && Number.isInteger(puzzleId) && (
                <Link
                  to={`/leaderboard/${selectedRun.modelName}/${puzzleId}`}
                  className="guess-sequence__run-link"
                >
                  View full run details →
                </Link>
              )}

              {selectedDetailLoading && (
                <p>
                  Loading {formatStrategyName(selectedRun.strategyName)} run
                  detail...
                </p>
              )}

              {selectedDetailError && (
                <p className="guess-sequence__error">{selectedDetailError}</p>
              )}

              {selectedDetail && (
                <ol className="guess-sequence__list">
                  {selectedDetail.guesses.map((guess) => (
                    <li key={guess.sequenceNumber} className="guess-sequence__guess">
                      <div
                        className={`guess-sequence__item guess-sequence__item--${guess.result}`}
                      >
                        <span className="guess-sequence__seq">
                          #{guess.sequenceNumber}
                        </span>
                        <span className="guess-sequence__words">
                          {guess.words.join(", ")}
                        </span>
                        <span className="guess-sequence__result">
                          {formatResult(guess.result)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function formatResult(result: GuessResult): string {
  switch (result) {
    case "success":
      return "✓ Correct";
    case "offBy1":
      return "One away";
    case "duplicate":
      return "Duplicate";
    case "failure":
      return "✗ Incorrect";
  }
}

function formatStrategyName(strategyName: string): string {
  if (strategyName === "llm-openai") return "LLM · OpenAI";
  if (strategyName === "llm-ollama") return "LLM · Ollama";
  return strategyName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// The model that produced a run's guesses (LLM runs only). Includes the
// context window when it was recorded, e.g. "mistral (2048 ctx)".
function formatModelDetail(run: StrategyRunListItem): string {
  if (!run.modelName) return "";
  return run.contextWindow
    ? `${run.modelName} (${run.contextWindow.toLocaleString()} ctx)`
    : run.modelName;
}

