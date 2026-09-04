import { useEffect, useState, type FormEvent } from "react";

export interface BulkActionModalProps {
  /** Modal heading — names the destructive bulk action, e.g. "Delete errored runs". */
  title: string;
  /** Red permanence warning shown above the password field. */
  warning: string;
  /** Confirm button label. Defaults to "Delete". */
  confirmLabel?: string;
  /** The actual bulk call. Given the typed password, resolves with the
   * backend's response (its `message` is shown on success); rejects with an
   * Error whose message is surfaced in-place. */
  action: (password: string) => Promise<{ message: string }>;
  onClose: () => void;
  /** Called once with the backend's message after the action succeeds — the
   * maintenance panel uses this to refetch its counts. */
  onDone?: (message: string) => void;
}

/** Confirmation modal for a destructive *bulk* maintenance action — the
 * DeleteRunModal overlay/password pattern, generalised: caller supplies the
 * title, warning, and the call to run. Unlike DeleteRunModal it doesn't
 * close itself on success; it shows the backend's result message (e.g.
 * "Deleted 3 errored strategy run(s)…") so the operator sees what happened,
 * and leaves a Close button. */
export function BulkActionModal({
  title,
  warning,
  confirmLabel = "Delete",
  action,
  onClose,
  onDone,
}: BulkActionModalProps) {
  // Only checked by the backend in production (DispatchAuthGuard) — left
  // blank this has no effect against a local/dev backend.
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);

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
      const result = await action(password);
      setResultMessage(result.message);
      onDone?.(result.message);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "The action failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="bench-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-action-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bench-modal">
        <h2 id="bulk-action-title" className="bench-modal__title">
          {title}
        </h2>

        {resultMessage ? (
          <>
            <p className="bench-muted">{resultMessage}</p>
            <div className="bench-modal__actions">
              <button type="button" className="bench-sort-btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="bench-error">{warning}</p>

            <form onSubmit={handleSubmit}>
              <label className="bench-modal__field">
                Password
                <input
                  type="password"
                  className="bench-modal__number"
                  autoComplete="off"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>

              {error ? <p className="bench-error">{error}</p> : null}

              <div className="bench-modal__actions">
                <button type="button" className="bench-sort-btn" onClick={onClose}>
                  Cancel
                </button>
                <button type="submit" className="bench-btn-danger" disabled={isSubmitting}>
                  {isSubmitting ? "Working…" : confirmLabel}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
