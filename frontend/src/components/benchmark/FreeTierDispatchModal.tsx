import { useEffect, useState, type FormEvent } from "react";
import {
  startBothFreeTierDispatch,
  startFreeTierDispatch,
} from "../../data/benchmark/api";
import type { FreeTierId } from "../../data/benchmark/types";

export interface FreeTierDispatchModalProps {
  onClose: () => void;
  /** Called once a submission actually changed dispatch state (a full
   * success, or a partial success for "both") — the parent bumps
   * FreeTierBudgetWidget's refreshSignal so it doesn't wait out its own
   * poll interval to reflect the change. Not called on a request that
   * failed outright (nothing changed). */
  onDispatchChanged: () => void;
}

const DEFAULT_THRESHOLD_PERCENT = 90;

type TierSelection = FreeTierId | "both";

const TIER_LABELS: Record<TierSelection, string> = {
  flagship: "Flagship",
  mini: "Mini & nano",
  both: "Both",
};

const TIER_OPTIONS: TierSelection[] = ["flagship", "mini", "both"];

/** Form for starting a continuous free-tier dispatch cycle (see
 * FreeTierBudgetWidget's "Disable" button for the reverse action) — tier
 * (flagship/mini/both) and a 1-100 threshold percent. Starting a single
 * tier rejects outright (thrown Error) if it's already running or the
 * threshold is out of range; starting "both" never rejects — each tier's
 * own outcome is reported independently, so one already-running tier
 * doesn't block the other from starting (see startBothFreeTierDispatch). */
export function FreeTierDispatchModal({ onClose, onDispatchChanged }: FreeTierDispatchModalProps) {
  const [tier, setTier] = useState<TierSelection>("both");
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD_PERCENT);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-tier result lines, shown only after a "both" submission where at
  // least one tier failed — kept distinct from `error` since this isn't a
  // failure of the request itself, just a mixed outcome the user should see
  // before the modal closes.
  const [bothResultLines, setBothResultLines] = useState<string[] | null>(null);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const isValidThreshold = Number.isInteger(threshold) && threshold >= 1 && threshold <= 100;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isValidThreshold) {
      setError("Threshold must be a whole number between 1 and 100.");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setBothResultLines(null);

    try {
      if (tier === "both") {
        const result = await startBothFreeTierDispatch(threshold);
        onDispatchChanged();

        const hasFailure = result.flagship.error !== null || result.mini.error !== null;
        if (hasFailure) {
          setBothResultLines(
            (["flagship", "mini"] as const).map((t) => {
              const outcome = result[t];
              return outcome.error
                ? `${TIER_LABELS[t]}: ${outcome.error}`
                : `${TIER_LABELS[t]}: started at ${outcome.status?.thresholdPercent}%.`;
            }),
          );
        } else {
          onClose();
        }
      } else {
        await startFreeTierDispatch(tier, threshold);
        onDispatchChanged();
        onClose();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to start auto-dispatch.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="bench-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="free-tier-dispatch-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bench-modal">
        <h2 id="free-tier-dispatch-title" className="bench-modal__title">
          Enable Auto-Dispatch
        </h2>

        <form onSubmit={handleSubmit}>
          <fieldset className="bench-modal__fieldset">
            <legend>Tier</legend>
            {TIER_OPTIONS.map((option) => (
              <label key={option} className="bench-modal__radio">
                <input
                  type="radio"
                  name="tier"
                  value={option}
                  checked={tier === option}
                  onChange={() => setTier(option)}
                />
                {TIER_LABELS[option]}
              </label>
            ))}
          </fieldset>

          <label className="bench-modal__field">
            Threshold (%)
            <input
              type="number"
              className="bench-modal__number"
              min={1}
              max={100}
              step={1}
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
            />
          </label>

          {error ? <p className="bench-error">{error}</p> : null}

          {bothResultLines ? (
            <ul className="bench-modal__results">
              {bothResultLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}

          <div className="bench-modal__actions">
            <button type="button" className="bench-sort-btn" onClick={onClose}>
              {bothResultLines ? "Close" : "Cancel"}
            </button>
            {bothResultLines ? null : (
              <button
                type="submit"
                className="bench-sort-btn"
                disabled={isSubmitting || !isValidThreshold}
              >
                {isSubmitting ? "Starting…" : "Start"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
