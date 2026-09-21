# Guess chain page — per-guess/per-step timestamp: implementation spec

**Origin:** This spec was produced in a grilling/planning session (the `grill-me` skill),
addressing a direct user request ("see a timestamp of when a particular guess was processed
on the guess chain page") — there is no corresponding `docs/architecture/NN-*.html` candidate
behind it, so it isn't numbered into that sequence.

**Branch:** `feature/guess-chain-timestamp`, off `master`.

---

## Goal

The "Guess chain" page (`GuessChainVisualizer.tsx`, mounted from `PuzzleRunsPage.tsx`) shows,
for each run, either the LLM prompt→proposal→guess chain (`PromptChain`/`PromptStep`/
`ProposalRow`) or a plain ordered guess list (`PlainGuessList`) — but renders no timestamp
anywhere. Add a timestamp so a viewer can tell when a given guess/proposal was actually
processed, without requiring any backend change: the underlying data
(`SolvePromptRecord.createdAt`, `GuessRecord.guessedAt`) is already fetched by
`fetchRunDetail` and already typed on the frontend; it's simply never rendered.

---

## Scope

### In scope

- `frontend/src/components/benchmark/GuessChainVisualizer.tsx` only:
  - `PromptStep` — add a relative-time label to the step header (next to `#{promptNumber}` /
    "Initial solve"/"Retry"), sourced from `prompt.createdAt`.
  - `PlainGuessList` — add a relative-time label to each guess row (next to
    `#{sequenceNumber}`), sourced from `guess.guessedAt`.
  - A new shared relative-time formatting utility, built for this feature.
  - A shared "now" ticking hook so labels re-render every 60s while the page is open.

### Out of scope (confirmed in grilling)

| Item | Why deferred |
|---|---|
| `GuessSequencePanel.tsx` (the older, secondary inline guess list shown elsewhere in the app) | User confirmed scope is the guess chain page only; touching a separate component would be scope creep. |
| Per-proposal timestamps in `ProposalRow` (e.g. `proposal.guess.guessedAt` or `LlmProposal.createdAt` shown per candidate) | User chose the step-header placement (Option A) over per-row: one timestamp per `PromptStep`, from `prompt.createdAt`, covers every proposal under that step — submitted or not — without needing per-proposal fallback logic. |
| Live data re-fetch / polling for new guesses on an in-progress run | Pre-existing behavior (the page already fetches once, no polling) and out of scope for this change — only the relative-time *label* re-renders on a timer, not the underlying data. |
| Absolute-date fallback for very old timestamps (e.g. "3 months ago" → switch to a date past some cutoff) | User confirmed no cutoff — the exact absolute timestamp is always available via the hover tooltip, so indefinite relative counting is fine and keeps the logic branch-free. |
| A UTC/fixed-timezone display | Matches existing house convention (`formatTimestamp` in `metrics.ts`) of showing wall-clock instants in the viewer's local browser timezone. |

---

## Design

### 1. New relative-time formatter

**File (new):** `frontend/src/data/benchmark/relativeTime.ts`

Uses the browser-native `Intl.RelativeTimeFormat` (no new dependency — matches the existing
house style of native `Intl` usage in `metrics.ts`). Compact/narrow style
("2m ago", "3h ago", "5d ago"), minute-level smallest unit (sub-minute deltas render as
`"0m ago"`/"just now"), no upper cutoff:

```ts
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });

const UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
];

/** Compact relative label ("2m ago", "3h ago") against `now`, with no cutoff —
 * counts up indefinitely. Callers supply `now` (rather than reading Date.now()
 * internally) so a single shared tick can re-render every visible label in
 * sync; see useRelativeNow. */
export function formatRelativeTime(iso: string, now: number): string {
  const deltaMs = now - new Date(iso).getTime();
  for (const { unit, ms } of UNITS) {
    if (Math.abs(deltaMs) >= ms) {
      return rtf.format(Math.round(-deltaMs / ms), unit);
    }
  }
  return rtf.format(0, "minute");
}
```

`numeric: "auto"` lets `Intl.RelativeTimeFormat` say "now" for a zero minute delta rather than
literal "0m ago"; every other case falls through to the narrow numeric form.

### 2. Shared ticking hook

**File (new):** `frontend/src/hooks/useRelativeNow.ts`

One `setInterval` shared by every mounted consumer on the guess chain page (not one timer per
row), so N step headers and M guess rows all re-render off a single 60s tick:

```ts
import { useEffect, useState } from "react";

/** Re-renders every `intervalMs` (default 60s) by ticking a timestamp forward,
 * so relative-time labels (formatRelativeTime) keep advancing while a page
 * stays open. One interval per call site — GuessChainVisualizer mounts this
 * once and passes `now` down, rather than each row starting its own timer. */
export function useRelativeNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
```

### 3. Wire into `GuessChainVisualizer`

**File:** `frontend/src/components/benchmark/GuessChainVisualizer.tsx`

- `GuessChainVisualizer` calls `const now = useRelativeNow();` once and threads `now` down as a
  prop to `PromptChain`/`PromptStep`/`PlainGuessList` (avoids each subcomponent starting its own
  timer).
- `PromptStep`'s header (`bench-step__head`, after the existing telemetry span) gets:
  ```tsx
  <span
    className="bench-mono bench-step__timestamp"
    title={formatTimestamp(prompt.createdAt)}
  >
    {formatRelativeTime(prompt.createdAt, now)}
  </span>
  ```
- `PlainGuessList`'s row (`bench-guess-list__item`, after `#{sequenceNumber}`) gets the same
  pattern sourced from `guess.guessedAt`:
  ```tsx
  <span
    className="bench-mono bench-guess-list__timestamp"
    title={formatTimestamp(guess.guessedAt)}
  >
    {formatRelativeTime(guess.guessedAt, now)}
  </span>
  ```
- `title` (native HTML tooltip attribute) reuses the existing `formatTimestamp` helper from
  `metrics.ts` — already renders in the viewer's local browser timezone, matching house
  convention — for the exact absolute instant on hover. This matches the existing precedent in
  the same file (`issueTagTitle` used as a `title` attribute on `bench-step__head`'s tag spans).
- Both timestamp spans use the existing `bench-mono`/muted styling already used for the
  telemetry string, so the new label reads as part of the existing dense, muted metadata row
  rather than standing out.
- `PromptStep`'s header always renders (including for `callError` steps, since the header is
  above the `isCallError ? <CallErrorDetail /> : ...` branch), so error steps get a timestamp
  too, automatically, with no special-casing needed.

### 4. Types

No new types needed — `SolvePromptRecord.createdAt: string` and `GuessRecord.guessedAt: string`
already exist in `frontend/src/data/benchmark/types.ts`.

---

## Tests

Per the `test-driven-development` skill — write the failing test first for each behavior change:

1. **`relativeTime.spec.ts`** (new): `formatRelativeTime` — sub-minute delta → "now"; 1 minute →
   "1m ago"; 45 minutes → "45m ago"; 3 hours → "3h ago"; 5 days → "5d ago"; multi-month delta →
   continues counting up (no cutoff/absolute-date fallback); a future instant (clock skew) does
   not throw.
2. **`useRelativeNow.spec.ts`** (new, if a hook-testing setup already exists in this frontend —
   otherwise cover via the component test below): confirms the returned value advances after the
   interval elapses (fake timers) and that unmounting clears the interval.
3. **`GuessChainVisualizer.spec.tsx`** (extend or create): renders a `PromptStep` and asserts the
   relative label text is present next to `#{promptNumber}` and that its `title` attribute
   contains the full absolute timestamp; same assertion for a `PlainGuessList` row against
   `#{sequenceNumber}`. Assert the label is present on a `callError` step's header too.

---

## Risks

- **`Intl.RelativeTimeFormat` browser support** — supported in all modern evergreen browsers;
  this is an internal admin/benchmark tool, not public-facing, so no polyfill is warranted.
- **Timer accumulation** — mitigated by using one shared `useRelativeNow()` call in
  `GuessChainVisualizer` rather than one timer per row; a chain with many steps/guesses still
  only runs a single `setInterval`.
- **Clock skew between server and browser** — `formatRelativeTime` takes `Math.abs` of the delta
  before picking a unit, so a slightly-future server timestamp (clock drift) still resolves to a
  sane label rather than a nonsensical negative duration.
