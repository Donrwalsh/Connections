import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "../auth/useAdminAuth";

/** Hidden login form for the site's one admin identity — not linked from
 * site navigation (see Header.tsx); reached only by visiting /admin-login
 * directly. On success the backend sets a 90-day session cookie and every
 * admin-only control elsewhere in the app becomes visible. */
export function AdminLoginPage() {
  const { login } = useAdminAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await login(password);
      navigate("/");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="bench-page">
      <header className="bench-page-header">
        <h1 className="bench-page-header__title">Admin login</h1>
      </header>

      <form onSubmit={handleSubmit}>
        <label className="bench-modal__field">
          Password
          <input
            type="password"
            className="bench-modal__number"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error ? <p className="bench-error">{error}</p> : null}

        <button type="submit" className="bench-btn-primary" disabled={isSubmitting || !password}>
          {isSubmitting ? "Logging in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
