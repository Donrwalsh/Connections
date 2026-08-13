# Connections Lab — Design reference

This is the standing style reference for the app. Treat it as a source of truth
across sessions — check it before styling anything new, and update it when a new
pattern gets established so it doesn't drift from what's actually in the codebase.

## Direction

Warm-editorial hero and copy, tabular density for data. The site should read as
approachable on first load (hero, plain-language framing) but scannable and
precise once you're in the leaderboard/calendar (aligned columns, monospace
numbers). Avoid tipping fully into either "marketing site" or "raw dev dashboard."

## Color

Two jobs for color: neutral UI chrome, and encoding data (strategy performance).
Keep these vocabularies separate — don't reuse the performance gradient for
generic UI accents.

**UI chrome**

- Neutral surfaces/text/borders (background, cards, body copy, hairlines) — use
  the app's base neutral palette, not custom hex values
- One accent color for "active/leading/selected" state — used consistently for:
  the top-ranked leaderboard row, the currently-selected strategy in a rail or
  tab, an active nav item. Same visual treatment (accent border) everywhere it
  appears, so it reads as one convention rather than one-off styling per
  component.
- Pinned accent: `#3B82F6` (medium blue), accent background tint `#EFF6FF`,
  accent border `rgba(59, 130, 246, 0.5)` (dark mode: `#60A5FA` /
  `rgba(59, 130, 246, 0.15)` / `rgba(96, 165, 250, 0.5)`). These are
  placeholder values to be confirmed by the styling pass — treat them as the
  standing defaults until then.

**Performance data (calendar, and anywhere per-puzzle results appear)**

- Sequential gradient across two hues (not red→green) representing fewer→more
  guesses: pick something like teal → amber. This is a "better ↔ worse along a
  continuum" scale, not a pass/fail signal.
- Two states break out of the gradient rather than sitting at either end:
  - Failed to solve → its own muted/desaturated color (e.g. dusty red), no
    number shown
  - Not yet run → no fill, dashed border, muted text only
- Always pair color with the actual number in the cell. Color alone is not
  sufficient (accessibility, and colorblind users specifically would lose the
  fewer/more distinction without the numeral).

## Typography

Three type roles, used deliberately and sparingly per role — don't let all three
show up in the same line of text:

- **Serif / display** — hero title, section headers that are editorial in tone,
  and strategy names specifically in the leaderboard (a deliberate accent against
  the otherwise tabular row)
- **Sans-serif** — everything else: body copy, labels, UI chrome, buttons
- **Monospace** — any number that represents a metric or count: guess counts,
  averages, success percentages, latency/token stats, calendar cell numbers.
  Numbers should always be monospace so columns of digits align and stay
  scannable.

## Shape & spacing

- Pill shape (fully rounded) for: status strip, links/buttons in the hero,
  metric-selector control, oldest/today quicklinks, calendar "viewing: [strategy]"
  selector
- Card radius ~12–16px for: leaderboard rows, calendar container, metric cards
- Calendar day cells: smaller radius (~8px) — distinguishable from cards, still
  soft
- Hairline borders (0.5px) for default separators; reserve a heavier accent
  border (~2px) exclusively for the "active/leading" state described above —
  don't use a thick border for anything else, or it stops meaning "this one is
  selected"

## Components

**Status pill** — single line, centered, rounded-full. Currently-running
info is the priority; queued-count is secondary and the first thing to shorten
or drop under space pressure.

**Leaderboard row**

- Desktop: rank (mono) · name (serif) · primary metric (mono) · secondary metric
  (mono, muted, right-aligned)
- Mobile: drop the rank column (position in the list implies rank); collapse to a
  2-line card — name + primary metric on line 1, secondary metric demoted to a
  smaller muted line below
- Top row gets the accent border treatment

**Metric selector** — pill/tab group on desktop (Avg guesses / Success rate /
Speed, etc.); collapses to a single dropdown control on mobile rather than
wrapping pills

**Calendar**

- 7-column month grid, day-of-week header row
- Cell: day number + guess count, both inside the cell, color per the
  performance gradient described above
- Legend directly below: gradient bar labeled "Fewer guesses ↔ More guesses" +
  swatches for "Failed to solve" / "Not yet run"
- Oldest / Today quicklinks below the legend, each showing the actual date
- Mobile degradation order if cells get too small: drop the day number from
  inside the cell first (keep guess count), before removing anything else

## Navigation

One shared header, persistent across every route (both the game and the
leaderboard area):

- **Left** — "Connections Lab" wordmark, set in the serif/display role but at a
  smaller size than the hero title. Links to `/leaderboard`. The wordmark never
  gets the active indicator.
- **Right** — four items:
  - "Today's puzzle" — direct text link to `/` (always visible, never nested
    behind the calendar). Active on exactly `/`.
  - Calendar icon — toggles a compact popover (not an inline calendar).
  - Shuffle icon — navigates to a random puzzle within the puzzle range
    (oldest ingested → today).
  - "Leaderboard" — text link to `/leaderboard`; active anywhere under
    `/leaderboard/...`.
- The calendar and shuffle items are always icons; the two text links collapse
  to icon + label buttons on mobile.
- Active item = 2px accent bottom border. This is the first place the
  accent-border convention is established in the header; it's reused later for
  the leading leaderboard row and the selected strategy.

**Calendar popover**

- Compact dropdown panel, ~14px radius, light shadow, anchored under the icon.
- Month header: `«` (go to oldest month), `‹` / `›` (previous/next month),
  `»` (go to latest month), and the month label. The double-angle arrows are
  the "jump all the way" versions of the single `‹` / `›` arrows. `«` / `‹`
  are disabled on the oldest month; `›` / `»` are disabled on the latest
  month.
- The calendar is restricted to the puzzle range: oldest ingested puzzle
  (2023-06-12) through today. The user can't navigate outside it, and dates
  outside it are shown inert (dimmed, not clickable).
- 7-column grid with weekday-letter header row.
- Cells show the day number and are rounded squares (~5px radius). Clicking an
  in-range date navigates to `/puzzle/:date`.
- Today: 1.5px accent outline.

## Layout & responsive rules

- Desktop: leaderboard and calendar sit side by side (~1.6fr / 1fr split),
  leaderboard on the left/primary side
- Mobile: single column, leaderboard before calendar (primary content first)
- Section order top to bottom, both breakpoints: hero → status → leaderboard →
  calendar
- Hero title and description shrink and rewrap on mobile rather than truncating

## Open conventions to keep consistent as the app grows

- The accent-border "active/leading" treatment should be the _only_ pattern used
  for that meaning anywhere in the app — if a new screen needs to mark something
  as selected/current/top, reuse this rather than inventing a new indicator
- Serif is reserved for headers and strategy names specifically — resist the urge
  to use it more broadly as the app grows, or the tabular sections will lose the
  density that makes them useful
- If a new data type needs a color-coded gradient (not just guess counts), reuse
  the fewer↔more sequential approach and the same two hues where the semantics
  match, rather than introducing a new gradient per feature
