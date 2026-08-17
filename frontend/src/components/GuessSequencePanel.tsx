import { useEffect, useRef, useState } from "react";

type GuessResult = "success" | "failure" | "offBy1" | "duplicate";

interface Guess {
  sequenceNumber: number;
  words: string[];
  result: GuessResult;
  guessedAt: string;
}

interface GuessDetail extends Guess {
  // The backend's GuessDetailDto no longer includes these keys, so they're
  // absent (undefined) on the actual response rather than sent as null.
  numResponses?: number | null;
  promptAttempts?: number | null;
  duplicatesRejected?: number | null;
  llmDetails?: {
    category?: string;
    confidence?: number;
    reasoning?: string;
    prompt?: string;
  } | null;
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

  // Which guess's detail panel is open (null = none). A single value gives
  // the accordion behavior: opening one guess closes any previously opened one.
  const [openGuess, setOpenGuess] = useState<number | null>(null);
  // Per-guess LLM detail is fetched lazily when a guess is opened, then cached
  // keyed by `${runId}:${sequenceNumber}`.
  const [guessDetails, setGuessDetails] = useState<Record<string, GuessDetail>>(
    {},
  );
  const [guessDetailLoading, setGuessDetailLoading] = useState<
    Record<string, boolean>
  >({});
  const [guessDetailErrors, setGuessDetailErrors] = useState<
    Record<string, string>
  >({});

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
    setOpenGuess(null);
    setGuessDetails({});
    setGuessDetailLoading({});
    setGuessDetailErrors({});

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

  // Collapse any open guess detail panel when the whole sequence panel closes.
  useEffect(() => {
    if (!isOpen) {
      setOpenGuess(null);
    }
  }, [isOpen]);

  // Ids whose per-guess detail is already fetched/cached, so the effect below
  // skips them without reading state it would otherwise have to declare.
  const fetchedGuessKeys = useRef<Set<string>>(new Set());

  // Fetch the LLM detail for the opened guess on demand, then cache it.
  useEffect(() => {
    if (!isOpen || !date || !selectedRun || openGuess === null) return;

    const key = `${selectedRun.id}:${openGuess}`;
    if (fetchedGuessKeys.current.has(key)) return;

    const controller = new AbortController();
    setGuessDetailLoading((prev) => ({ ...prev, [key]: true }));
    setGuessDetailErrors((prev) => ({ ...prev, [key]: "" }));

    const load = async () => {
      try {
        const res = await fetch(
          apiUrl(
            `/strategy/${selectedRun.strategyName}/puzzle/${date}/run/${selectedRun.trialNumber}/guess/${openGuess}`,
          ),
          { signal: controller.signal },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            body?.message ?? `Request failed with status ${res.status}`,
          );
        }
        const detail: GuessDetail = await res.json();
        if (!controller.signal.aborted) {
          setGuessDetails((prev) => ({ ...prev, [key]: detail }));
          fetchedGuessKeys.current.add(key);
        }
      } catch (err: unknown) {
        if (
          (err as Error)?.name !== "AbortError" &&
          !controller.signal.aborted
        ) {
          setGuessDetailErrors((prev) => ({
            ...prev,
            [key]:
              err instanceof Error
                ? err.message
                : "Failed to load guess details",
          }));
        }
      } finally {
        if (!controller.signal.aborted) {
          setGuessDetailLoading((prev) => ({ ...prev, [key]: false }));
        }
      }
    };

    load();
    return () => controller.abort();
  }, [isOpen, date, selectedRun, openGuess]);

  const handleStrategyClick = (strategyId: string) => {
    if (isOpen && activeStrategy === strategyId) {
      onToggle();
    } else {
      if (strategyId !== activeStrategy) {
        setActiveRunId(null);
        setOpenGuess(null);
      }
      setActiveStrategy(strategyId);
      if (!isOpen) {
        onToggle();
      }
    }
  };

  const handleGuessClick = (sequenceNumber: number) => {
    // Toggle the clicked guess; selecting a different one replaces the open
    // panel (accordion), since there is only ever one open guess.
    setOpenGuess((prev) => (prev === sequenceNumber ? null : sequenceNumber));
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
                      onClick={() => {
                        setActiveRunId(run.id);
                        setOpenGuess(null);
                      }}
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
                  {selectedDetail.guesses.map((guess) => {
                    const detailKey = `${selectedRun.id}:${guess.sequenceNumber}`;
                    const isOpen = openGuess === guess.sequenceNumber;
                    const detail = guessDetails[detailKey];
                    const detailLoading = guessDetailLoading[detailKey];
                    const detailError = guessDetailErrors[detailKey];

                    return (
                      <li
                        key={guess.sequenceNumber}
                        className="guess-sequence__guess"
                      >
                        <button
                          type="button"
                          className={`guess-sequence__item guess-sequence__item--${guess.result} ${
                            isOpen ? "guess-sequence__item--open" : ""
                          }`}
                          onClick={() => handleGuessClick(guess.sequenceNumber)}
                          aria-expanded={isOpen}
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
                        </button>

                        {isOpen && (
                          <div className="guess-sequence__details">
                            {detailLoading && (
                              <p className="guess-sequence__details-loading">
                                Loading guess details...
                              </p>
                            )}
                            {detailError && !detailLoading && (
                              <p className="guess-sequence__error">
                                {detailError}
                              </p>
                            )}
                            {detail && <GuessDetailFields detail={detail} />}
                          </div>
                        )}
                      </li>
                    );
                  })}
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

function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString();
}

function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function DetailField({
  label,
  value,
  full = false,
}: {
  label: string;
  value: string;
  full?: boolean;
}) {
  return (
    <div
      className={
        full
          ? "guess-sequence__detail guess-sequence__detail--full"
          : "guess-sequence__detail"
      }
    >
      <dt className="guess-sequence__detail-label">{label}</dt>
      <dd className="guess-sequence__detail-value">{value}</dd>
    </div>
  );
}

function GuessDetailFields({ detail }: { detail: GuessDetail }) {
  const llm = detail.llmDetails;
  return (
    <dl className="guess-sequence__details-grid">
      <DetailField
        label="Number of responses"
        value={formatCount(detail.numResponses)}
      />
      <DetailField
        label="Prompt attempts"
        value={formatCount(detail.promptAttempts)}
      />
      <DetailField
        label="Duplicates rejected"
        value={formatCount(detail.duplicatesRejected)}
      />
      <DetailField
        label="Guessed at"
        value={formatTimestamp(detail.guessedAt)}
      />
      <DetailField label="Category" value={llm?.category ?? "—"} />
      <DetailField
        label="Confidence"
        value={formatConfidence(llm?.confidence)}
      />
      <DetailField label="Reasoning" value={llm?.reasoning ?? "—"} full />
      <DetailField label="Prompt" value={llm?.prompt ?? "—"} full />
    </dl>
  );
}
