import { useEffect, useState } from "react";

/** Ticks forward every `intervalMs` (default 60s) so relative-time labels
 * (formatRelativeTime) keep advancing while a page stays open. Callers mount
 * this once and thread the returned value down to every consumer, rather
 * than each row starting its own timer. */
export function useRelativeNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
