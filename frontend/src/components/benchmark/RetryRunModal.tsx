import { useEffect, useState, type FormEvent } from "react";
import { retryRun } from "../../data/benchmark/api";

export interface RetryRunModalProps {
  runId: number;
  onClose: () => void;
}

/** Confirmation modal for manually resuming a run stuck in the 'error'
 * status — same overlay pattern as DeleteRunModal, but non-destructive: on
 * success it stays open with a confirmation instead of closing, since
 * (unlike a delete) the run doesn't disappear from view, and v1 has no live
 * progress polling — the admin refreshes the page manually to see the new
 * steps once the job has run. */
export function RetryRunModal({ runId, onClose }: RetryRunModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await retryRun(runId);
      setSucceeded(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to retry run.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="bench-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="retry-run-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bench-modal">
        <h2 id="retry-run-title" className="bench-modal__title">
          Manually retry run #{runId}
        </h2>

        {succeeded ? (
          <>
            <p>
              Run #{runId} has been requeued and is resuming from its last successful call. Refresh
              the page to see progress.
            </p>
            <div className="bench-modal__actions">
              <button type="button" className="bench-sort-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <p>
              This resumes run #{runId} from its last successful call and makes new, real model API
              calls. Previously successful calls are kept.
            </p>
            {error ? <p className="bench-error">{error}</p> : null}

            <div className="bench-modal__actions">
              <button type="button" className="bench-sort-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="bench-sort-btn" disabled={isSubmitting}>
                {isSubmitting ? "Retrying…" : "Retry"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
