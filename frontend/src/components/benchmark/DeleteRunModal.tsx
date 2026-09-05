import { useEffect, useState, type FormEvent } from "react";
import { deleteRun } from "../../data/benchmark/api";
import type { DeleteRunResult } from "../../data/benchmark/types";

export interface DeleteRunModalProps {
  runId: number;
  onClose: () => void;
  /** Called once the run is actually deleted, with the backend's deleted
   * counts — the caller (PuzzleRunsPage) uses this to refresh its run list
   * rather than leaving a stale, now-nonexistent run in view. */
  onDeleted: (result: DeleteRunResult) => void;
}

/** Confirmation modal for permanently deleting a strategy run — same
 * overlay pattern as FreeTierDispatchModal, scaled down to what a
 * destructive single-run action needs: a warning, Cancel/Delete. Auth
 * travels via the admin session cookie (see AdminAuthContext), not a
 * password field. */
export function DeleteRunModal({ runId, onClose, onDeleted }: DeleteRunModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const result = await deleteRun(runId);
      onDeleted(result);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete run.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="bench-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-run-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bench-modal">
        <h2 id="delete-run-title" className="bench-modal__title">
          Delete run #{runId}
        </h2>

        <p className="bench-error">
          This permanently deletes run #{runId} and everything tied to it (guesses, solve prompts,
          LLM proposals). This cannot be undone.
        </p>

        <form onSubmit={handleSubmit}>
          {error ? <p className="bench-error">{error}</p> : null}

          <div className="bench-modal__actions">
            <button type="button" className="bench-sort-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="bench-btn-danger" disabled={isSubmitting}>
              {isSubmitting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
