# Image-Based Puzzle Dates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest and render NYT Connections dates that use images instead of plain text on their cards, replacing the hardcoded skip-list with automatic detection, and backfill the 7 historical dates that were previously skipped forever.

**Architecture:** Ingestion detects a puzzle's card shape (`content` vs `image_url`/`image_alt_text`) from the fetched JSON and normalizes both into the same `word`/`position`/`imageUrl` shape before insert, so `GroupMember.word` always holds plain answer text (the alt text, for image puzzles) and every downstream consumer (solving strategies, the orchestrator, sharing, benchmarking) needs zero changes. A new nullable `image_url` column carries the image reference alongside that text, and a new `is_image_puzzle` flag on `Puzzle` records which dates were irregular. The frontend carries image URLs through a parallel `word -> imageUrl` map rather than restructuring `words` into objects, so only `Tile`/`Board` need to know images exist at all.

**Tech Stack:** NestJS + TypeORM + Postgres (backend), React + Vite + Vitest + Testing Library (frontend), Jest (backend tests).

**Spec:** [docs/superpowers/specs/2026-08-20-image-based-puzzle-dates-design.md](../specs/2026-08-20-image-based-puzzle-dates-design.md)

## Global Constraints

- `GroupMember.word` must always hold plain answer text for every puzzle — `image_alt_text` for image cards, `content` for text cards. Nothing downstream (strategies, orchestrator, `CategoryReveal`, `GameOverModal`, `ShareResult`, benchmark tables) may be changed to consume anything else.
- `PuzzleCategoryDto.words: string[]` and `wordOrder: string[]` (backend) and `Category.words: string[]` (frontend) stay exactly as they are today — image URLs travel through a separate, optional `images: Record<string, string>` map, never by restructuring `words`.
- A card that matches neither the text shape (`content`) nor the image shape (`image_url` + `image_alt_text`) must throw during ingestion, not silently store `undefined`.
- A category whose cards mix text and image shapes must throw during ingestion.
- `CategoryReveal` and `GameOverModal` are explicitly out of scope — they keep rendering `cat.words.join(", ")` as plain text (see spec Non-goals).

---

### Task 1: Schema — `is_image_puzzle` and `image_url` columns

**Files:**
- Modify: `backend/src/modules/game/entities/puzzle.entity.ts`
- Modify: `backend/src/modules/game/entities/group-member.entity.ts`
- Create: `backend/src/migrations/1765000000000-add-image-puzzle-support.ts`

**Interfaces:**
- Produces: `Puzzle.is_image_puzzle: boolean` (entity column, default `false`), `GroupMember.image_url: string | null` (entity column, nullable). Every later task that touches `Puzzle` or `GroupMember` rows relies on these two properties existing.

- [ ] **Step 1: Add `is_image_puzzle` to the `Puzzle` entity**

Edit `backend/src/modules/game/entities/puzzle.entity.ts`:

```ts
import "reflect-metadata";
import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from "typeorm";
import { AnswerGroup } from "./answer-group.entity";

@Entity("Puzzle")
export class Puzzle {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "date" })
  date: string;

  @Column({ type: "boolean", default: false })
  is_image_puzzle: boolean;

  @OneToMany(() => AnswerGroup, (group) => group.puzzle)
  answerGroups: AnswerGroup[];
}
```

- [ ] **Step 2: Add `image_url` to the `GroupMember` entity**

Edit `backend/src/modules/game/entities/group-member.entity.ts`:

```ts
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from "typeorm";
import { AnswerGroup } from "./answer-group.entity";

@Entity("GroupMember")
@Index("UQ_GroupMember_group_word", ["group", "word"], { unique: true })
export class GroupMember {
  @PrimaryGeneratedColumn("identity")
  id!: number;

  @Column({ type: "text" })
  word!: string;

  @Column({ type: "integer" })
  position!: number;

  @Column({ type: "text", nullable: true })
  image_url!: string | null;

  @ManyToOne(() => AnswerGroup, (group) => group.members, {
    nullable: false,
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "group_id" })
  group!: AnswerGroup;
}
```

- [ ] **Step 3: Write the migration**

Create `backend/src/migrations/1765000000000-add-image-puzzle-support.ts`:

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backs image-based puzzle dates (NYT dates whose cards carry image_url/
 * image_alt_text instead of content) — is_image_puzzle records which dates
 * were irregular, image_url carries the per-card image reference alongside
 * the existing plain-text word column.
 */
export class AddImagePuzzleSupport1765000000000 implements MigrationInterface {
  name = "AddImagePuzzleSupport1765000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "Puzzle" ADD COLUMN "is_image_puzzle" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "GroupMember" ADD COLUMN "image_url" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "GroupMember" DROP COLUMN "image_url"`);
    await queryRunner.query(`ALTER TABLE "Puzzle" DROP COLUMN "is_image_puzzle"`);
  }
}
```

- [ ] **Step 4: Verify the backend still builds**

Run: `cd backend && npm run build`
Expected: builds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/game/entities/puzzle.entity.ts backend/src/modules/game/entities/group-member.entity.ts backend/src/migrations/1765000000000-add-image-puzzle-support.ts
git commit -m "feat: add is_image_puzzle and image_url columns"
```

---

### Task 2: Ingestion — shape detection and normalization

**Files:**
- Modify: `backend/src/modules/game/puzzle-ingestion.service.ts`
- Modify: `backend/src/modules/game/puzzle-ingestion.service.spec.ts`

**Interfaces:**
- Consumes: `Puzzle.is_image_puzzle: boolean`, `GroupMember.image_url: string | null` (Task 1).
- Produces: `PuzzleIngestionService` no longer has an `AWKWARD_DATES` set or the "known irregular date" skip branch in `populateUntilCaughtUp`. Its private `insertPuzzle(formattedDate: string, data: ConnectionsPuzzle): Promise<number | null>` now normalizes each card via a new private `normalizeCard(card: ConnectionsCard, formattedDate: string): NormalizedCard` (`{ word: string; position: number; imageUrl: string | null }`) and sets `is_image_puzzle`/`image_url` on the inserted rows. This is what Task 3's `ingestSpecificDates` and Task 4's DTO mapping rely on being correct.

- [ ] **Step 1: Replace the card/puzzle type declarations and drop `AWKWARD_DATES`**

In `backend/src/modules/game/puzzle-ingestion.service.ts`, replace lines 15-35 (the `ConnectionsCard`/`ConnectionsGroup`/`ConnectionsPuzzle` interfaces and the `AWKWARD_DATES` set) with:

```ts
interface ConnectionsTextCard {
  content: string;
  position: number;
}
interface ConnectionsImageCard {
  position: number;
  image_url: string;
  image_alt_text: string;
}
type ConnectionsCard = ConnectionsTextCard | ConnectionsImageCard;
interface ConnectionsGroup {
  title: string;
  cards: ConnectionsCard[];
}
interface ConnectionsPuzzle {
  categories: ConnectionsGroup[];
}

interface NormalizedCard {
  word: string;
  position: number;
  imageUrl: string | null;
}
```

- [ ] **Step 2: Remove the skip branch from `populateUntilCaughtUp`**

In the same file, in the `while (true) { ... }` loop inside `populateUntilCaughtUp`, replace:

```ts
      const nextDate = this.addDays(latestDate, 1);
      const formatted = this.formatDate(nextDate);

      if (AWKWARD_DATES.has(formatted)) {
        this.logger.log(`Skipping ${formatted} (known irregular NYT date)`);
        latestDate = nextDate;
        continue;
      }

      const puzzleData = await this.loadPuzzleData(formatted);
```

with:

```ts
      const nextDate = this.addDays(latestDate, 1);
      const formatted = this.formatDate(nextDate);

      const puzzleData = await this.loadPuzzleData(formatted);
```

- [ ] **Step 3: Add `normalizeCard` and rewrite `insertPuzzle`**

Replace the existing `insertPuzzle` method with:

```ts
  private normalizeCard(card: ConnectionsCard, formattedDate: string): NormalizedCard {
    if ("content" in card) {
      return { word: card.content, position: card.position, imageUrl: null };
    }
    if ("image_url" in card && "image_alt_text" in card) {
      return { word: card.image_alt_text, position: card.position, imageUrl: card.image_url };
    }
    throw new Error(
      `Unrecognized card shape for ${formattedDate}: card has neither 'content' nor ` +
        `'image_url'/'image_alt_text'`,
    );
  }

  private async insertPuzzle(
    formattedDate: string,
    data: ConnectionsPuzzle,
  ): Promise<number | null> {
    const normalizedCategories = data.categories.map((category) => ({
      title: category.title,
      cards: category.cards.map((card) => this.normalizeCard(card, formattedDate)),
    }));

    for (const category of normalizedCategories) {
      const imageCount = category.cards.filter((card) => card.imageUrl !== null).length;
      if (imageCount !== 0 && imageCount !== category.cards.length) {
        throw new Error(
          `Category '${category.title}' in puzzle ${formattedDate} mixes text and image cards`,
        );
      }
    }

    const isImagePuzzle = normalizedCategories.some((category) =>
      category.cards.some((card) => card.imageUrl !== null),
    );

    return this.dataSource.transaction(async (manager) => {
      const puzzle = await manager
        .getRepository(Puzzle)
        .createQueryBuilder()
        .insert()
        .into(Puzzle)
        .values({ date: formattedDate, is_image_puzzle: isImagePuzzle })
        .orIgnore()
        .returning("id")
        .execute();

      if (puzzle.identifiers.length === 0 || !puzzle.identifiers[0]?.id) {
        this.logger.warn(`${formattedDate} already existed — skipped (concurrent run?)`);
        return null;
      }
      const puzzleId = puzzle.identifiers[0].id;

      // One batched insert for all 4 groups (save() returns them in input
      // order, with generated ids populated), then one batched insert for
      // every group's members across all 4 groups — 2 round trips instead
      // of 8 (a save() per category, plus a members save() per category).
      const groups = await manager.getRepository(AnswerGroup).save(
        normalizedCategories.map((category, level) => ({
          puzzle: { id: puzzleId } as Puzzle,
          level,
          group_name: category.title,
        })),
      );

      const members = normalizedCategories.flatMap((category, level) =>
        category.cards.map((card) => ({
          group: { id: groups[level]!.id } as AnswerGroup,
          word: card.word,
          position: card.position,
          image_url: card.imageUrl,
        })),
      );
      await manager.getRepository(GroupMember).save(members);

      this.logger.log(`Inserted puzzle for ${formattedDate}`);
      return puzzleId;
    });
  }
```

- [ ] **Step 4: Remove the now-obsolete "skip known awkward NYT dates" test**

In `backend/src/modules/game/puzzle-ingestion.service.spec.ts`, delete this entire test block from the `populateUntilCaughtUp` describe block (it tests behavior that no longer exists):

```ts
    it("should skip known awkward NYT dates without fetching", async () => {
      mockLatestDate(2024, 11, 11);

      const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce(fetchResponse(404));

      const result = await service.populateUntilCaughtUp();

      expect(result).toEqual({ inserted: 0, upToDate: "2024-12-12" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("2024-12-13"),
        expect.anything(),
      );
    });
```

- [ ] **Step 5: Add an image-puzzle fixture and assert `is_image_puzzle: false` on the existing text-puzzle test**

In the same spec file, add this fixture right after `PUZZLE_DATA`:

```ts
const IMAGE_PUZZLE_DATA = {
  categories: [
    {
      title: "Fruits",
      cards: [
        { position: 0, image_url: "https://example.com/apple.svg", image_alt_text: "APPLE" },
        { position: 1, image_url: "https://example.com/banana.svg", image_alt_text: "BANANA" },
        { position: 2, image_url: "https://example.com/cherry.svg", image_alt_text: "CHERRY" },
        { position: 3, image_url: "https://example.com/date.svg", image_alt_text: "DATE" },
      ],
    },
  ],
};

const MIXED_SHAPE_PUZZLE_DATA = {
  categories: [
    {
      title: "Mixed",
      cards: [
        { content: "APPLE", position: 0 },
        { position: 1, image_url: "https://example.com/banana.svg", image_alt_text: "BANANA" },
        { content: "CHERRY", position: 2 },
        { content: "DATE", position: 3 },
      ],
    },
  ],
};

const UNKNOWN_SHAPE_PUZZLE_DATA = {
  categories: [
    {
      title: "Broken",
      cards: [
        { position: 0 },
        { content: "BANANA", position: 1 },
        { content: "CHERRY", position: 2 },
        { content: "DATE", position: 3 },
      ],
    },
  ],
};
```

In the `describe("insertPuzzle", ...)` block, replace the existing "should persist the puzzle, groups, and members and return the id" test with a version that also asserts `is_image_puzzle: false` was inserted, and add three new tests for the image/mixed/unknown cases:

```ts
    it("should persist the puzzle, groups, and members and return the id", async () => {
      const result = await (
        service as unknown as {
          insertPuzzle(d: string, data: unknown): Promise<number | null>;
        }
      ).insertPuzzle("2024-01-02", PUZZLE_DATA);

      expect(result).toBe(42);
      expect(mockRepo.createQueryBuilder().values).toHaveBeenCalledWith({
        date: "2024-01-02",
        is_image_puzzle: false,
      });
      expect(mockRepo.save).toHaveBeenNthCalledWith(1, [
        {
          puzzle: { id: 42 },
          level: 0,
          group_name: "Fruits",
        },
      ]);
      expect(mockRepo.save).toHaveBeenNthCalledWith(2, [
        { group: { id: 1 }, word: "APPLE", position: 0, image_url: null },
        { group: { id: 1 }, word: "BANANA", position: 1, image_url: null },
        { group: { id: 1 }, word: "CHERRY", position: 2, image_url: null },
        { group: { id: 1 }, word: "DATE", position: 3, image_url: null },
      ]);
    });

    it("should persist image cards with their image_url and mark the puzzle as an image puzzle", async () => {
      const result = await (
        service as unknown as {
          insertPuzzle(d: string, data: unknown): Promise<number | null>;
        }
      ).insertPuzzle("2024-12-12", IMAGE_PUZZLE_DATA);

      expect(result).toBe(42);
      expect(mockRepo.createQueryBuilder().values).toHaveBeenCalledWith({
        date: "2024-12-12",
        is_image_puzzle: true,
      });
      expect(mockRepo.save).toHaveBeenNthCalledWith(2, [
        { group: { id: 1 }, word: "APPLE", position: 0, image_url: "https://example.com/apple.svg" },
        { group: { id: 1 }, word: "BANANA", position: 1, image_url: "https://example.com/banana.svg" },
        { group: { id: 1 }, word: "CHERRY", position: 2, image_url: "https://example.com/cherry.svg" },
        { group: { id: 1 }, word: "DATE", position: 3, image_url: "https://example.com/date.svg" },
      ]);
    });

    it("should throw when a category mixes text and image cards", async () => {
      await expect(
        (
          service as unknown as {
            insertPuzzle(d: string, data: unknown): Promise<number | null>;
          }
        ).insertPuzzle("2024-12-13", MIXED_SHAPE_PUZZLE_DATA),
      ).rejects.toThrow("Category 'Mixed' in puzzle 2024-12-13 mixes text and image cards");
      expect(mockRepo.save).not.toHaveBeenCalled();
    });

    it("should throw when a card matches neither the text nor image shape", async () => {
      await expect(
        (
          service as unknown as {
            insertPuzzle(d: string, data: unknown): Promise<number | null>;
          }
        ).insertPuzzle("2024-12-14", UNKNOWN_SHAPE_PUZZLE_DATA),
      ).rejects.toThrow(
        "Unrecognized card shape for 2024-12-14: card has neither 'content' nor " +
          "'image_url'/'image_alt_text'",
      );
      expect(mockRepo.save).not.toHaveBeenCalled();
    });
```

- [ ] **Step 6: Run the ingestion spec and verify everything passes**

Run: `cd backend && npx jest src/modules/game/puzzle-ingestion.service.spec.ts`
Expected: all tests pass, none reference `AWKWARD_DATES`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/game/puzzle-ingestion.service.ts backend/src/modules/game/puzzle-ingestion.service.spec.ts
git commit -m "feat: detect image-based puzzle dates by card shape instead of a hardcoded list"
```

---

### Task 3: Backfill — `ingestSpecificDates` and the one-off script

**Files:**
- Modify: `backend/src/modules/game/puzzle-ingestion.service.ts`
- Modify: `backend/src/modules/game/puzzle-ingestion.service.spec.ts`
- Create: `backend/src/scripts/backfill-image-puzzle-dates.ts`

**Interfaces:**
- Consumes: `PuzzleIngestionService.loadPuzzleData`, `.insertPuzzle`, `.dispatchStrategyRuns`, `.delay` (private, all pre-existing / Task 2).
- Produces: `PuzzleIngestionService.ingestSpecificDates(dates: string[]): Promise<{ inserted: number; skipped: string[] }>` (public method) — used by the backfill script.

- [ ] **Step 1: Write the failing tests for `ingestSpecificDates`**

Add this `describe` block to `backend/src/modules/game/puzzle-ingestion.service.spec.ts`, after the `describe("insertPuzzle", ...)` block:

```ts
  describe("ingestSpecificDates", () => {
    beforeEach(() => {
      jest
        .spyOn(service as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);
    });

    it("should insert a puzzle for each date and report the count", async () => {
      jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(fetchResponse(200, PUZZLE_DATA))
        .mockResolvedValueOnce(fetchResponse(200, IMAGE_PUZZLE_DATA));

      const result = await service.ingestSpecificDates(["2024-01-02", "2024-12-12"]);

      expect(result).toEqual({ inserted: 2, skipped: [] });
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it("should skip and record a date the NYT endpoint 404s for", async () => {
      jest.spyOn(global, "fetch").mockResolvedValueOnce(fetchResponse(404));

      const result = await service.ingestSpecificDates(["2024-01-02"]);

      expect(result).toEqual({ inserted: 0, skipped: ["2024-01-02"] });
    });

    it("should skip and record a date that already exists", async () => {
      mockExecute.mockResolvedValueOnce({ identifiers: [] });
      jest.spyOn(global, "fetch").mockResolvedValueOnce(fetchResponse(200, PUZZLE_DATA));

      const result = await service.ingestSpecificDates(["2024-01-02"]);

      expect(result).toEqual({ inserted: 0, skipped: ["2024-01-02"] });
    });

    it("should dispatch strategy runs for each inserted date", async () => {
      jest
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(fetchResponse(200, PUZZLE_DATA))
        .mockResolvedValueOnce(fetchResponse(200, IMAGE_PUZZLE_DATA));

      await service.ingestSpecificDates(["2024-01-02", "2024-12-12"]);

      expect(mockStrategyQueue.addBulk).toHaveBeenCalledTimes(2);
    });
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd backend && npx jest src/modules/game/puzzle-ingestion.service.spec.ts -t "ingestSpecificDates"`
Expected: FAIL — `service.ingestSpecificDates is not a function`.

- [ ] **Step 3: Implement `ingestSpecificDates`**

Add this public method to `PuzzleIngestionService`, right after `populateUntilCaughtUp`:

```ts
  /**
   * Ingests a fixed list of dates directly, bypassing the "day after
   * latest" forward walk in populateUntilCaughtUp — for backfilling
   * specific historical gaps (e.g. dates that were previously skipped by
   * the old AWKWARD_DATES allowlist) that the forward walk can never reach,
   * since it only ever advances from MAX(puzzle.date).
   */
  async ingestSpecificDates(dates: string[]): Promise<{ inserted: number; skipped: string[] }> {
    let inserted = 0;
    const skipped: string[] = [];

    for (const formatted of dates) {
      const puzzleData = await this.loadPuzzleData(formatted);

      if (puzzleData === null) {
        this.logger.warn(`No NYT puzzle found for ${formatted} — skipping`);
        skipped.push(formatted);
        await this.delay(500);
        continue;
      }

      const puzzleId = await this.insertPuzzle(formatted, puzzleData);

      if (puzzleId !== null) {
        await this.dispatchStrategyRuns(puzzleId, formatted);
        this.logger.log(`Backfilled puzzle for ${formatted} (id ${puzzleId})`);
        inserted++;
      } else {
        skipped.push(formatted);
      }

      await this.delay(500);
    }

    this.logger.log(`Backfill complete: inserted ${inserted}, skipped ${skipped.length}`);
    return { inserted, skipped };
  }
```

- [ ] **Step 4: Run the tests again to verify they pass**

Run: `cd backend && npx jest src/modules/game/puzzle-ingestion.service.spec.ts`
Expected: all tests pass.

- [ ] **Step 5: Write the backfill script**

Create `backend/src/scripts/backfill-image-puzzle-dates.ts`:

```ts
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "../app.module";
import { PuzzleIngestionService } from "../modules/game/puzzle-ingestion.service";

/**
 * One-off backfill for the historical dates that were previously skipped by
 * the old AWKWARD_DATES allowlist in PuzzleIngestionService, before shape
 * detection replaced it. Run once after deploying image-puzzle support:
 *
 *   npx tsx src/scripts/backfill-image-puzzle-dates.ts
 */
const HISTORICAL_IMAGE_DATES = [
  "2024-12-12",
  "2025-04-01",
  "2025-10-31",
  "2026-02-07",
  "2026-03-07",
  "2026-04-01",
  "2026-05-06",
];

async function main() {
  const logger = new Logger("BackfillImagePuzzleDates");
  const appContext = await NestFactory.createApplicationContext(AppModule);

  try {
    const puzzleIngestionService = appContext.get(PuzzleIngestionService);
    const result = await puzzleIngestionService.ingestSpecificDates(HISTORICAL_IMAGE_DATES);
    logger.log(`Backfill result: ${JSON.stringify(result)}`);
  } finally {
    await appContext.close();
  }
}

main();
```

- [ ] **Step 6: Verify the script compiles**

Run: `cd backend && npm run build`
Expected: builds with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/game/puzzle-ingestion.service.ts backend/src/modules/game/puzzle-ingestion.service.spec.ts backend/src/scripts/backfill-image-puzzle-dates.ts
git commit -m "feat: add ingestSpecificDates and a backfill script for historical image dates"
```

*Note: running the script against the real database (`npx tsx src/scripts/backfill-image-puzzle-dates.ts` from `backend/`, with `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` and Redis reachable) is a deployment step, not part of this plan's automated verification — do it once after this branch is deployed. Verify afterward with `SELECT date, is_image_puzzle FROM "Puzzle" WHERE date IN ('2024-12-12','2025-04-01','2025-10-31','2026-02-07','2026-03-07','2026-04-01','2026-05-06');` — all 7 rows should exist with `is_image_puzzle = true`.*

---

### Task 4: Backend API — `images` map on `PuzzleResponseDto`

**Files:**
- Modify: `backend/src/modules/game/game.service.ts`
- Modify: `backend/src/modules/game/game.service.spec.ts`

**Interfaces:**
- Consumes: `Puzzle.is_image_puzzle: boolean`, `GroupMember.image_url: string | null` (Task 1).
- Produces: `PuzzleResponseDto.isImagePuzzle: boolean` and `PuzzleResponseDto.images?: Record<string, string>` — the frontend (Task 6) mirrors this exact shape.

- [ ] **Step 1: Write the failing tests**

In `backend/src/modules/game/game.service.spec.ts`, update the two existing `getPuzzleByDate`-adjacent mock entities to include `is_image_puzzle: false` and their expected results to include `isImagePuzzle: false`.

For "should call getPuzzleByDate if date format is valid" (in `describe("getDatesPuzzle", ...)`), change the mock and expectation to:

```ts
    it("should call getPuzzleByDate if date format is valid", async () => {
      const validDate = "2026-07-30";

      mockPuzzleRepo.findOne.mockResolvedValueOnce({
        id: 1,
        date: validDate,
        is_image_puzzle: false,
        answerGroups: [
          {
            id: 10,
            group_name: "Fruits",
            level: 0,
            members: [{ word: "APPLE", position: 0, image_url: null }],
          },
        ],
      });

      const result = await service.getDatesPuzzle(validDate);

      expect(result).toEqual({
        id: 1,
        date: validDate,
        isImagePuzzle: false,
        categories: [
          {
            id: "cat-10",
            name: "Fruits",
            difficulty: "yellow",
            words: ["APPLE"],
          },
        ],
        wordOrder: ["APPLE"],
      });
      expect(mockPuzzleRepo.findOne).toHaveBeenCalledTimes(1);
    });
```

For "should correctly format categories and map levels to difficulty colors" (in `describe("getPuzzleByDate", ...)`), add `is_image_puzzle: false` to `mockPuzzleEntity` and `image_url: null` to every member, and add `isImagePuzzle: false` to the expected result:

```ts
    it("should correctly format categories and map levels to difficulty colors", async () => {
      const mockPuzzleEntity = {
        id: 100,
        date: "2026-07-30",
        is_image_puzzle: false,
        answerGroups: [
          {
            id: 1,
            group_name: "Yellow Cat",
            level: 0,
            members: [
              { word: "Word 1", position: 5, image_url: null },
              { word: "Word 2", position: 2, image_url: null },
            ],
          },
          {
            id: 2,
            group_name: "Green Cat",
            level: 1,
            members: [{ word: "Word 3", position: 0, image_url: null }],
          },
          {
            id: 3,
            group_name: "Blue Cat",
            level: 2,
            members: [{ word: "Word 4", position: 4, image_url: null }],
          },
          {
            id: 4,
            group_name: "Purple Cat",
            level: 3,
            members: [{ word: "Word 5", position: 1, image_url: null }],
          },
          {
            id: 5,
            group_name: "Fallback Cat",
            level: 99,
            members: [{ word: "Word 6", position: 3, image_url: null }],
          },
        ],
      };

      mockPuzzleRepo.findOne.mockResolvedValueOnce(mockPuzzleEntity);

      const result = await service.getPuzzleByDate("2026-07-30");

      expect(result).toEqual({
        id: 100,
        date: "2026-07-30",
        isImagePuzzle: false,
        categories: [
          {
            id: "cat-1",
            name: "Yellow Cat",
            difficulty: "yellow",
            words: ["Word 1", "Word 2"],
          },
          {
            id: "cat-2",
            name: "Green Cat",
            difficulty: "green",
            words: ["Word 3"],
          },
          {
            id: "cat-3",
            name: "Blue Cat",
            difficulty: "blue",
            words: ["Word 4"],
          },
          {
            id: "cat-4",
            name: "Purple Cat",
            difficulty: "purple",
            words: ["Word 5"],
          },
          {
            id: "cat-5",
            name: "Fallback Cat",
            difficulty: "yellow",
            words: ["Word 6"],
          },
        ],
        wordOrder: ["Word 3", "Word 5", "Word 2", "Word 6", "Word 4", "Word 1"],
      });
    });
```

Add a new test to the same `describe("getPuzzleByDate", ...)` block:

```ts
    it("should populate the images map and isImagePuzzle flag for an image puzzle", async () => {
      mockPuzzleRepo.findOne.mockResolvedValueOnce({
        id: 200,
        date: "2024-12-12",
        is_image_puzzle: true,
        answerGroups: [
          {
            id: 1,
            group_name: "Fruits",
            level: 0,
            members: [
              { word: "APPLE", position: 0, image_url: "https://example.com/apple.svg" },
              { word: "BANANA", position: 1, image_url: "https://example.com/banana.svg" },
            ],
          },
        ],
      });

      const result = await service.getPuzzleByDate("2024-12-12");

      expect(result.isImagePuzzle).toBe(true);
      expect(result.images).toEqual({
        APPLE: "https://example.com/apple.svg",
        BANANA: "https://example.com/banana.svg",
      });
    });
```

Update `describe("getTodaysPuzzle", ...)`'s mocked return value to include `isImagePuzzle: false`:

```ts
      const spy = jest.spyOn(service, "getPuzzleByDate").mockResolvedValue({
        id: 1,
        date: expectedToday,
        isImagePuzzle: false,
        categories: [],
        wordOrder: [],
      });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx jest src/modules/game/game.service.spec.ts`
Expected: FAIL — `isImagePuzzle`/`images` missing from actual results, and a TypeScript error on the `getTodaysPuzzle` mock once `isImagePuzzle` becomes a required field in Step 3.

- [ ] **Step 3: Update `PuzzleResponseDto` and `getPuzzleByDate`**

In `backend/src/modules/game/game.service.ts`, replace the `PuzzleResponseDto` interface:

```ts
export interface PuzzleResponseDto {
  id: number;
  date: string;
  categories: PuzzleCategoryDto[];
  wordOrder: string[];
  isImagePuzzle: boolean;
  images?: Record<string, string>;
}
```

Replace the body of `getPuzzleByDate` from the `// 3. Map relations to your response DTO/format` comment onward:

```ts
    // 3. Map relations to your response DTO/format
    const allMembers = puzzle.answerGroups.flatMap((group) => group.members);

    const images: Record<string, string> = {};
    for (const member of allMembers) {
      if (member.image_url) {
        images[member.word] = member.image_url;
      }
    }

    const value: PuzzleResponseDto = {
      id: puzzle.id,
      date: puzzle.date,
      categories: puzzle.answerGroups.map((group) => ({
        id: `cat-${group.id}`,
        name: group.group_name,
        difficulty: this.levelToColor(group.level),
        words: group.members.map((member) => member.word),
      })),
      wordOrder: [...allMembers].sort((a, b) => a.position - b.position).map((m) => m.word),
      isImagePuzzle: puzzle.is_image_puzzle,
      ...(Object.keys(images).length > 0 && { images }),
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest src/modules/game/game.service.spec.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/game/game.service.ts backend/src/modules/game/game.service.spec.ts
git commit -m "feat: expose isImagePuzzle and a word-to-image-URL map on PuzzleResponseDto"
```

---

### Task 5: Frontend — `Tile` image rendering with text fallback

**Files:**
- Modify: `frontend/src/components/Tile.tsx`
- Modify: `frontend/src/components/__tests__/Tile.test.tsx`
- Modify: `frontend/src/App.css`

**Interfaces:**
- Produces: `Tile` accepts an optional `imageUrl?: string` prop. When set and the image hasn't failed to load, it renders an `<img src={imageUrl} alt={word} className="tile__image" onError={...} />` instead of the fitted text; on load failure it falls back to the existing text rendering. `Board` (Task 6) relies on this prop name and behavior.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `frontend/src/components/__tests__/Tile.test.tsx`, inside the existing `describe("Tile Component", ...)` block:

```ts
  it("renders an image tile when imageUrl is provided", () => {
    render(
      <Tile {...defaultProps} imageUrl="https://example.com/apple.svg" />,
    );

    const img = screen.getByRole("img", { name: "APPLE" });
    expect(img).toHaveAttribute("src", "https://example.com/apple.svg");
  });

  it("falls back to text when the image fails to load", () => {
    render(
      <Tile {...defaultProps} imageUrl="https://example.com/broken.svg" />,
    );

    const img = screen.getByRole("img", { name: "APPLE" });
    fireEvent.error(img);

    expect(screen.getByText("APPLE")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/__tests__/Tile.test.tsx`
Expected: FAIL — no `img` role found (`Tile` doesn't accept `imageUrl` yet).

- [ ] **Step 3: Implement image rendering in `Tile`**

Replace the full contents of `frontend/src/components/Tile.tsx`:

```tsx
import { memo, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

interface TileProps {
  word: string;
  imageUrl?: string;
  isSelected: boolean;
  isConfirmed: boolean;
  shouldShake: boolean;
  onToggle: (word: string) => void;
}

// Fallbacks in case computed styles aren't available (jsdom).
const BASE_FONT_FALLBACK = 15;
const MIN_FONT_SIZE = 8;
// Minimum gap left between the fitted text and the tile's left/right edges,
// so words never sit flush against the sides of the cell.
const H_PAD = 12;

function TileBase({
  word,
  imageUrl,
  isSelected,
  isConfirmed,
  shouldShake,
  onToggle,
}: TileProps) {
  const tileRef = useRef<HTMLButtonElement>(null);
  // Some image dates' asset URLs go stale — fall back to the word's plain
  // text rather than leaving a blank tile when the image fails to load.
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(imageUrl) && !imageFailed;

  // Fit the text to the cell. Phrases may wrap onto multiple lines at spaces
  // ("Baseball Glove" → two lines); the font only shrinks when a single
  // unbreakable word or the wrapped block would overflow the tile. Keeping the
  // text within the fixed-size cell means a long word can't widen its grid
  // column and knock the board off-center. Skipped entirely for image tiles,
  // which have no text to fit.
  useLayoutEffect(() => {
    if (showImage) return;

    const tile = tileRef.current;
    if (!tile) return;

    const fit = () => {
      tile.style.fontSize = "";
      const base = parseFloat(getComputedStyle(tile).fontSize) || BASE_FONT_FALLBACK;
      const available = tile.clientWidth - 2 * H_PAD;
      if (available <= 0) return;
      const availableHeight = tile.clientHeight;

      const textWidth = tile.scrollWidth;
      const textHeight = tile.scrollHeight;
      if (textWidth <= available && textHeight <= availableHeight) return;

      const scale = Math.min(
        textWidth > available ? available / textWidth : 1,
        textHeight > availableHeight ? availableHeight / textHeight : 1,
      );
      const fitted = Math.max(MIN_FONT_SIZE, base * scale);
      tile.style.fontSize = `${fitted}px`;
    };

    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(tile);
    return () => observer.disconnect();
  }, [word, showImage]);

  const className = [
    "tile",
    isSelected && "tile--selected",
    isConfirmed && "tile--confirmed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <motion.button
      ref={tileRef}
      layout
      layoutId={word}
      className={className}
      type="button"
      onClick={() => onToggle(word)}
      aria-pressed={isSelected}
      // Disabled during the confirm window so a player can't toggle a
      // tile that's about to leave the board.
      disabled={isConfirmed}
      transition={{ layout: { duration: 0.3, ease: "easeInOut" } }}
      exit={{ opacity: 0, scale: 0.7 }}
      animate={
        shouldShake
          ? { x: [0, -8, 8, -8, 8, 0] }
          : isConfirmed
            ? { scale: [1, 1.05, 1] }
            : { x: 0 }
      }
    >
      {showImage ? (
        <img
          src={imageUrl}
          alt={word}
          className="tile__image"
          onError={() => setImageFailed(true)}
        />
      ) : (
        word
      )}
    </motion.button>
  );
}

// With a stable onToggle (from useConnectionsGame) and memoized Tile, toggling
// a word only re-renders the affected tile instead of all 16 on every
// selection change.
export const Tile = memo(TileBase);
```

- [ ] **Step 4: Add tile image styling**

In `frontend/src/App.css`, add this rule right after the `.tile` block (after line 35, before `.tile:hover`):

```css
.tile__image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  pointer-events: none;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/__tests__/Tile.test.tsx`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Tile.tsx frontend/src/components/__tests__/Tile.test.tsx frontend/src/App.css
git commit -m "feat: render image tiles with a text fallback on load failure"
```

---

### Task 6: Frontend — `Puzzle` type, `Board` wiring, and `Game` pass-through

**Files:**
- Modify: `frontend/src/data/types.ts`
- Modify: `frontend/src/components/Board.tsx`
- Modify: `frontend/src/components/Game.tsx`
- Modify: `frontend/src/components/__tests__/Board.test.tsx`
- Modify: `frontend/src/components/__tests__/Game.test.tsx`
- Modify: `frontend/src/__tests__/App.test.tsx`
- Modify: `frontend/src/pages/__tests__/PuzzlePage.test.tsx`

**Interfaces:**
- Consumes: `PuzzleResponseDto.isImagePuzzle`/`.images` shape (Task 4), `Tile`'s `imageUrl?: string` prop (Task 5).
- Produces: `Puzzle.isImagePuzzle: boolean`, `Puzzle.images?: Record<string, string>` (frontend type); `Board` accepts an optional `images?: Record<string, string>` prop and forwards `images?.[word]` to each `Tile`.

- [ ] **Step 1: Add `isImagePuzzle`/`images` to the `Puzzle` type**

In `frontend/src/data/types.ts`, replace the `Puzzle` interface:

```ts
export interface Puzzle {
  id: number;
  date: string;
  categories: Category[];
  wordOrder: string[];
  isImagePuzzle: boolean;
  images?: Record<string, string>;
}
```

- [ ] **Step 2: Write the failing `Board` tests**

Add these two tests to `frontend/src/components/__tests__/Board.test.tsx`, inside the existing `describe("Board Component", ...)` block:

```ts
  it("passes each word's image URL through to its tile", () => {
    render(
      <Board
        words={["APPLE"]}
        images={{ APPLE: "https://example.com/apple.svg" }}
        selected={[]}
        shakeWords={[]}
        confirmedWords={[]}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByRole("img", { name: "APPLE" })).toHaveAttribute(
      "src",
      "https://example.com/apple.svg",
    );
  });

  it("renders text tiles for words with no entry in images", () => {
    render(
      <Board
        words={["APPLE"]}
        images={{ BANANA: "https://example.com/banana.svg" }}
        selected={[]}
        shakeWords={[]}
        confirmedWords={[]}
        onToggle={() => {}}
      />,
    );

    expect(screen.getByText("APPLE")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/__tests__/Board.test.tsx`
Expected: FAIL — `Board` doesn't accept an `images` prop yet (TypeScript error) and no `img` role is rendered.

- [ ] **Step 4: Wire `images` through `Board`**

Replace the full contents of `frontend/src/components/Board.tsx`:

```tsx
import { AnimatePresence } from "framer-motion";
import { Tile } from "./Tile";

interface BoardProps {
  words: string[];
  images?: Record<string, string>;
  selected: string[];
  shakeWords: string[];
  confirmedWords: string[];
  onToggle: (word: string) => void;
}

export function Board({
  words,
  images,
  selected,
  shakeWords,
  confirmedWords,
  onToggle,
}: BoardProps) {
  return (
    <div className="board">
      <AnimatePresence>
        {words.map((word) => (
          <Tile
            key={word}
            word={word}
            imageUrl={images?.[word]}
            isSelected={selected.includes(word)}
            isConfirmed={confirmedWords.includes(word)}
            shouldShake={shakeWords.includes(word)}
            onToggle={onToggle}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}
```

- [ ] **Step 5: Pass `puzzle.images` from `Game`**

In `frontend/src/components/Game.tsx`, update the `<Board ... />` call:

```tsx
      <Board
        words={state.remainingWords}
        images={puzzle.images}
        selected={state.selected}
        shakeWords={state.shakeWords}
        confirmedWords={state.pendingSolve?.words ?? []}
        onToggle={toggleWord}
      />
```

- [ ] **Step 6: Update the three `Puzzle`-typed test fixtures for the new required field**

In `frontend/src/components/__tests__/Game.test.tsx`, add `isImagePuzzle: false` to the `puzzle` object (after the `wordOrder` array, before the closing `};` around line 61):

```ts
const puzzle: Puzzle = {
  id: 1,
  date: "2024-01-15",
  categories,
  wordOrder: [
    "HAIL",
    "RAIN",
    "SLEET",
    "SNOW",
    "BUCKS",
    "HEAT",
    "JAZZ",
    "NETS",
    "OPTION",
    "RETURN",
    "SHIFT",
    "TAB",
    "KAYAK",
    "LEVEL",
    "MOM",
    "RACECAR",
  ],
  isImagePuzzle: false,
};
```

In `frontend/src/__tests__/App.test.tsx`, add `isImagePuzzle: false` to `puzzleResponse`:

```ts
const puzzleResponse = {
  id: 1,
  date: "2024-01-15",
  categories,
  wordOrder: categories.flatMap((c) => c.words),
  isImagePuzzle: false,
};
```

In `frontend/src/pages/__tests__/PuzzlePage.test.tsx`, add `isImagePuzzle: false` to `puzzleResponse`:

```ts
const puzzleResponse = {
  id: 1,
  date: "2024-01-15",
  categories,
  wordOrder: categories.flatMap((c) => c.words),
  isImagePuzzle: false,
};
```

- [ ] **Step 7: Run the full frontend test suite to verify everything passes**

Run: `cd frontend && npx vitest run`
Expected: all tests pass, including `Board.test.tsx`, `Tile.test.tsx`, `Game.test.tsx`, `App.test.tsx`, `PuzzlePage.test.tsx`, and `data/__tests__/types.test.ts`.

- [ ] **Step 8: Type-check the frontend**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/data/types.ts frontend/src/components/Board.tsx frontend/src/components/Game.tsx frontend/src/components/__tests__/Board.test.tsx frontend/src/components/__tests__/Game.test.tsx frontend/src/__tests__/App.test.tsx frontend/src/pages/__tests__/PuzzlePage.test.tsx
git commit -m "feat: render image puzzles on the board via a word-to-image-URL map"
```

---

## After all tasks

- Run the full backend suite: `cd backend && npm run test` — should pass with no references to `AWKWARD_DATES` remaining anywhere (`grep -r AWKWARD_DATES backend/src` should return nothing).
- Run the full frontend suite: `cd frontend && npx vitest run`.
- Deploy the branch, run the migration (`npm run migration:run` from `backend/`), then run the backfill script once (see Task 3's note) to backfill the 7 historical dates.
- Manually verify in a browser: load an image-based date (e.g. `/puzzle/2024-12-12` once backfilled) and confirm the board renders images, tiles remain selectable/guessable, and AI Assist still solves it using the alt text.
