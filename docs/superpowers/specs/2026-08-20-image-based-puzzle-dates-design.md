# Image-Based Puzzle Dates — Design

## Problem

Most NYT Connections dates return a JSON payload where each card carries
`content` (plain answer text). A minority of dates instead render an
illustrated board: each card carries `image_url` and `image_alt_text`
instead of `content`. The backend currently detects these by a hardcoded
`AWKWARD_DATES` set in `puzzle-ingestion.service.ts` and skips them forever —
no `Puzzle` row is ever created for those dates, so they're permanently
absent from the app (unplayable, unsolved, missing from the benchmark
leaderboard).

Example payloads:

- Text date: `https://www.nytimes.com/svc/connections/v2/2026-07-28.json`
  → `{"content": "CAPTAIN", "position": 0}`
- Image date: `https://www.nytimes.com/svc/connections/v2/2024-12-12.json`
  → `{"position": 10, "image_url": "https://games-assets.storage.googleapis.com/...svg", "image_alt_text": "TEA"}`

Critically, `image_alt_text` is the answer word in caps, same as `content`
would be. This means the existing text-based game logic, deterministic
solving strategies, and LLM strategies (all of which consume `word` as a
plain string) can play/solve image-date puzzles unmodified, as long as
ingestion normalizes `image_alt_text` into the same `word` field used for
text puzzles.

## Goals

- Ingest image-based dates instead of skipping them, storing enough to
  render the original image board in the frontend.
- Detect image-based dates automatically from the fetched JSON's shape,
  rather than maintaining a hand-curated list of known dates.
- Keep a queryable record of which dates were image-based (audit/debugging
  value), in addition to shape detection driving the actual branching logic.
- Backfill the 7 already-known, already-skipped historical dates so they
  become playable and appear in the benchmark leaderboard like any other
  puzzle.
- Leave solving logic (deterministic strategies, LLM strategies, the
  orchestrator's prompt builder) completely unmodified.

## Non-goals

- Rendering images in `CategoryReveal`'s solved-answers recap list (stays
  text/alt-text only — thumbnails there are a future nice-to-have, not
  required for the puzzle to be genuinely playable).
- Locally caching/mirroring puzzle images (the app already hotlinks NYT's
  JSON API directly; images are hotlinked the same way, consistent with
  existing style).
- Any change to how solving strategies or the orchestrator consume puzzle
  data — none is needed.

## Design

### 1. Detection

Replace the hardcoded `AWKWARD_DATES` set with shape detection on the
fetched JSON: a card with `content` is a text card; a card with
`image_url`/`image_alt_text` instead is an image card. `ConnectionsCard`
becomes a union of the two shapes; ingestion normalizes both into the same
internal representation (`word`, `position`, optional `imageUrl`) before
insert. If a category's cards don't consistently match one shape or the
other, ingestion throws a clear error rather than silently storing
`undefined` — this shouldn't happen given NYT's format, but a loud failure
beats corrupt data.

This removes the manual-curation step: any future image-based date is
picked up the moment NYT publishes it, with no code change required.

### 2. Data model

- `Puzzle` entity: new `is_image_puzzle: boolean` column (`NOT NULL DEFAULT
  false`), set at insert time from the detected shape. This is the
  "queryable record" — driven by the same detection that branches ingestion
  logic, not inferred separately.
- `GroupMember` entity: new nullable `image_url: text` column, populated
  only for image puzzles.
- `GroupMember.word` continues to hold plain answer text for every puzzle —
  `image_alt_text` for image puzzles, `content` for text puzzles. This is
  what keeps every downstream consumer (solving logic, LLM strategies,
  orchestrator prompts, sharing, benchmarking) working unmodified.
- One migration adds both columns.

### 3. API surface

`PuzzleResponseDto` (backend `game.service.ts`) and the frontend `Puzzle`
type (`frontend/src/data/types.ts`) both gain:

- `isImagePuzzle: boolean`
- `images?: Record<string, string>` — word → image URL, populated only when
  `isImagePuzzle` is true.

`PuzzleCategoryDto`/`Category.words: string[]` and `wordOrder: string[]` are
**unchanged**. This is a parallel lookup map rather than restructuring
`words` into `{text, imageUrl}[]` objects. The object-based alternative was
considered and rejected: it would ripple through every consumer of
`words`/`wordOrder` (`Tile`, `Board`, `gameReducer`, `ShareResult`,
`GuessChainVisualizer`, benchmark tables, the orchestrator's prompt
builder) for a distinction that only a handful of puzzles need. With a
parallel map, only `Tile`/`Board` need to know images exist at all.

### 4. Backfill

The 7 known historical image dates (`2024-12-12`, `2025-04-01`,
`2025-10-31`, `2026-02-07`, `2026-03-07`, `2026-04-01`, `2026-05-06`) are
all before today's `MAX(puzzle.date)`. `populateUntilCaughtUp()` only walks
forward from the latest existing date, so removing the skip alone will not
reach backward to fill these gaps.

Add `ingestSpecificDates(dates: string[])` to `PuzzleIngestionService`,
reusing the same fetch/cache/insert/dispatch-strategy-runs path as the
forward walk, just driven by an explicit date list instead of "day after
latest." Invoke it once via a throwaway script (not a permanent endpoint or
scheduled job) to backfill the 7 dates. Each backfilled puzzle also gets its
strategy runs dispatched, so it appears in the benchmark leaderboard like
any other date.

### 5. Frontend rendering

- `Tile` gains an optional `imageUrl?: string` prop. When present, it
  renders an `<img>` (`object-fit: contain`, sized to the existing tile
  box) with `alt={word}`, instead of the fitted text. On `onError` (broken
  or expired URL) it falls back to the existing text rendering, so a dead
  image never leaves a blank tile.
- `Board` looks up each word in `puzzle.images` and passes the URL through
  to `Tile` when present.
- `CategoryReveal` is unchanged — it keeps showing `cat.words.join(", ")`
  as plain text in the solved-answers recap (see Non-goals).

### 6. Solving strategies and orchestrator — no changes

Because `GroupMember.word` is always plain text, every deterministic
strategy, every LLM strategy, and the orchestrator's prompt builder needs
zero changes. AI Assist and benchmark strategy runs solve image-date
puzzles exactly like text ones, using the alt text as the words.

## Testing

- `puzzle-ingestion.service.spec.ts`: fixtures for both card shapes;
  assert correct `is_image_puzzle`/`image_url` population; a case
  confirming detection is driven by shape, not by a literal date string.
- New test for `ingestSpecificDates`.
- Frontend: `Tile.test.tsx`/`Board.test.tsx` gain an image-mode case,
  including the broken-image fallback path.
- A `game.service` test confirms `images` is populated only for image
  puzzles and omitted otherwise.

## Edge cases

- A category whose cards don't consistently match one shape: ingestion
  throws rather than silently storing `undefined` (see Detection).
- An image URL becomes unreachable later (NYT CDN churn): handled by the
  `Tile` `onError` fallback to text (see Frontend rendering).
