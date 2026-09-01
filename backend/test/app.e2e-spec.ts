import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Server } from "http";
import * as http from "http";
import request from "supertest";
import { DataSource } from "typeorm";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { AnswerGroup } from "../src/modules/game/entities/answer-group.entity";
import { GroupMember } from "../src/modules/game/entities/group-member.entity";
import { Puzzle } from "../src/modules/game/entities/puzzle.entity";
import { Guess, GuessResult, GuessSource } from "../src/modules/strategy/entities/guess.entity";
import {
  SolvePrompt,
  SolvePromptType,
} from "../src/modules/strategy/entities/solve-prompt.entity";
import {
  LlmProposal,
  LlmProposalStatus,
} from "../src/modules/strategy/entities/llm-proposal.entity";
import {
  StrategyRun,
  StrategyRunStatus,
} from "../src/modules/strategy/entities/strategy-run.entity";
import { LlmStrategyRunner } from "../src/modules/strategy/llm-strategy-runner.service";
import { llmOpenAIQueue } from "../src/modules/queue/strategy.queue";
import { freeTierDispatchQueue } from "../src/modules/queue/free-tier-dispatch.queue";

const TEST_DATE = "1999-12-31";

const TEST_GROUPS = [
  { level: 0, name: "YELLOW CATEGORY", words: ["AAAA", "BBBB", "CCCC", "DDDD"] },
  { level: 1, name: "GREEN CATEGORY", words: ["EEEE", "FFFF", "GGGG", "HHHH"] },
  { level: 2, name: "BLUE CATEGORY", words: ["IIII", "JJJJ", "KKKK", "LLLL"] },
  { level: 3, name: "PURPLE CATEGORY", words: ["MMMM", "NNNN", "OOOO", "PPPP"] },
];

describe("App (e2e)", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let orchestrator: Server;

  beforeAll(async () => {
    // Stand-in for the real orchestrator service so /api/diagnose is testable
    // without an OpenAI key.
    orchestrator = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/solve-assist" && req.method === "POST") {
          // Reply with whichever TEST_GROUPS group is still fully present in
          // the latest prompt's remaining-items list, so each call makes
          // real progress instead of re-proposing an already-solved group
          // (which the runner correctly skips, stalling the run forever).
          const parsed = JSON.parse(body || "{}") as {
            messages?: { role: string; content: string }[];
          };
          const lastUserMessage = [...(parsed.messages ?? [])]
            .reverse()
            .find((m) => m.role === "user");
          const promptText = lastUserMessage?.content ?? "";
          const nextGroup =
            TEST_GROUPS.find((g) => g.words.every((w) => promptText.includes(w))) ??
            TEST_GROUPS[0];
          const words = nextGroup.words;

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              response:
                `### GROUPS\n#### Group 1\nCategory: E2E fake\nWords: ${words.join(", ")}\n\n` +
                `### ANSWER\n${words.join(", ")}`,
              groups: [words],
              model: "e2e-fake-model",
            }),
          );
        } else if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
        } else if (req.url === "/diagnose" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              response: "Reasoning.\nANSWER:\nAAAA, BBBB, CCCC, DDDD\nEEEE, FFFF, GGGG, HHHH",
              groups: [
                ["AAAA", "BBBB", "CCCC", "DDDD"],
                ["EEEE", "FFFF", "GGGG", "HHHH"],
              ],
              model: "e2e-fake-model",
            }),
          );
        } else if (req.url === "/judge-category" && req.method === "POST") {
          // Fake judge: always returns a fixed "correct" verdict.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              verdict: "correct",
              rationale: "The proposed category is identical to the actual category.",
              model: "e2e-fake-judge-model",
              latencyMs: 100,
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => orchestrator.listen(3999, resolve));

    // abortOnError: false — surface init errors to the test runner instead of
    // letting Nest abort the process.
    app = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    });
    await configureApp(app);
    await app.init();
    dataSource = app.get(DataSource);
    await seedPuzzle();
  }, 60000);

  afterAll(async () => {
    await cleanupPuzzle();
    await app.close();
    await new Promise<void>((resolve) => orchestrator.close(() => resolve()));
  }, 60000);

  async function seedPuzzle(): Promise<void> {
    const puzzle = await dataSource.getRepository(Puzzle).save({ date: TEST_DATE });

    // Real NYT members carry global 0-15 board positions, and loadOrCreateRun
    // sorts the pool by position — so the seed must use global positions too,
    // otherwise the strategy pool interleaves words across answer groups.
    for (const [groupIndex, group] of TEST_GROUPS.entries()) {
      const answerGroup = await dataSource.getRepository(AnswerGroup).save({
        puzzle,
        level: group.level,
        group_name: group.name,
      });
      await dataSource.getRepository(GroupMember).save(
        group.words.map((word, position) => ({
          group: answerGroup,
          word,
          position: groupIndex * 4 + position,
        })),
      );
    }
  }

  async function cleanupPuzzle(): Promise<void> {
    await dataSource.query(
      `DELETE FROM "Guess" WHERE "puzzleId" IN (SELECT "id" FROM "Puzzle" WHERE "date" = '${TEST_DATE}')`,
    );
    await dataSource.query(
      `DELETE FROM "StrategyRun" WHERE "puzzleId" IN (SELECT "id" FROM "Puzzle" WHERE "date" = '${TEST_DATE}')`,
    );
    await dataSource.query(
      `DELETE FROM "GroupMember" WHERE "group_id" IN (SELECT "id" FROM "AnswerGroup" WHERE "puzzle_id" IN (SELECT "id" FROM "Puzzle" WHERE "date" = '${TEST_DATE}'))`,
    );
    await dataSource.query(
      `DELETE FROM "AnswerGroup" WHERE "puzzle_id" IN (SELECT "id" FROM "Puzzle" WHERE "date" = '${TEST_DATE}')`,
    );
    await dataSource.query(`DELETE FROM "Puzzle" WHERE "date" = '${TEST_DATE}'`);
  }

  it("GET /health reports the database as up", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "up" });
  });

  it("GET /game/puzzle/:date returns the seeded puzzle", async () => {
    const res = await request(app.getHttpServer()).get(`/game/puzzle/${TEST_DATE}`);

    expect(res.status).toBe(200);
    expect(res.body.date).toBe(TEST_DATE);
    expect(res.body.categories).toHaveLength(4);
    expect(res.body.categories[0]).toEqual({
      id: expect.any(String),
      name: "YELLOW CATEGORY",
      difficulty: "yellow",
      words: ["AAAA", "BBBB", "CCCC", "DDDD"],
    });
    expect(res.headers["cache-control"]).toContain("max-age=86400");
  });

  it("GET /game/puzzle/:date rejects a malformed date", async () => {
    const res = await request(app.getHttpServer()).get("/game/puzzle/not-a-date");
    expect(res.status).toBe(404);
  });

  it("GET /strategy/:strategy/puzzle/:date validates the strategy name", async () => {
    const res = await request(app.getHttpServer()).get(`/strategy/bogus/puzzle/${TEST_DATE}`);
    expect(res.status).toBe(400);
  });

  it("GET /strategy/models returns the seeded model catalog priced from its current ModelPrice row", async () => {
    const res = await request(app.getHttpServer()).get("/strategy/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategyName: "llm-openai",
          modelName: "gpt-4.1-nano",
          supported: true,
          inputCostPerMillionTokens: expect.any(Number),
          outputCostPerMillionTokens: expect.any(Number),
        }),
        expect.objectContaining({
          strategyName: "llm-openai",
          modelName: "gpt-5-nano",
          supported: true,
          inputCostPerMillionTokens: expect.any(Number),
          outputCostPerMillionTokens: expect.any(Number),
        }),
      ]),
    );
    // The old SupportedModel-only cost field is gone now that pricing lives
    // on ModelPrice — nothing in this project ever priced cached input
    // tokens, so it wasn't carried over.
    expect(res.body[0]).not.toHaveProperty("cachedInputCostPerMillionTokens");
  });

  it("GET /strategy/:strategyName/runs sorts by tokenCost using each row's real per-model rate", async () => {
    // Rate comes from the live seeded catalog rather than a hardcoded
    // number, so this doesn't drift if a future migration changes the
    // price — only the token counts below (which this test controls) need
    // to differ enough to produce a clear ordering.
    const models = await request(app.getHttpServer()).get("/strategy/models");
    const rate = (
      models.body as Array<{
        modelName: string;
        inputCostPerMillionTokens: number;
        outputCostPerMillionTokens: number;
      }>
    ).find((m) => m.modelName === "gpt-4.1-nano")!;

    const puzzle = await dataSource.getRepository(Puzzle).findOneByOrFail({ date: TEST_DATE });
    const cheapRun = await dataSource.getRepository(StrategyRun).save({
      puzzle,
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano",
      trialNumber: 201,
      availableWords: ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"],
      currentCombination: [0, 1, 2, 3],
    });
    const expensiveRun = await dataSource.getRepository(StrategyRun).save({
      puzzle,
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano",
      trialNumber: 202,
      availableWords: ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"],
      currentCombination: [0, 1, 2, 3],
    });
    await dataSource.getRepository(SolvePrompt).save({
      strategyRunId: cheapRun.id,
      promptNumber: 1,
      promptType: SolvePromptType.INITIAL_SOLVE,
      promptTokens: 1000,
      completionTokens: 500,
    });
    await dataSource.getRepository(SolvePrompt).save({
      strategyRunId: expensiveRun.id,
      promptNumber: 1,
      promptType: SolvePromptType.INITIAL_SOLVE,
      promptTokens: 1_000_000,
      completionTokens: 500_000,
    });

    const res = await request(app.getHttpServer()).get(
      "/strategy/llm-openai/runs?model=gpt-4.1-nano&sortBy=tokenCost&sortDir=asc&limit=500",
    );

    expect(res.status).toBe(200);
    const ids = (res.body.rows as Array<{ id: number }>).map((row) => row.id);
    // Ascending: the cheap run's index must precede the expensive run's.
    expect(ids.indexOf(cheapRun.id)).toBeLessThan(ids.indexOf(expensiveRun.id));

    const cheapRow = res.body.rows.find((row: { id: number }) => row.id === cheapRun.id);
    const expensiveRow = res.body.rows.find((row: { id: number }) => row.id === expensiveRun.id);
    expect(cheapRow.tokenCostUsd).toBeCloseTo(
      (1000 / 1_000_000) * rate.inputCostPerMillionTokens +
        (500 / 1_000_000) * rate.outputCostPerMillionTokens,
    );
    expect(expensiveRow.tokenCostUsd).toBeCloseTo(
      (1_000_000 / 1_000_000) * rate.inputCostPerMillionTokens +
        (500_000 / 1_000_000) * rate.outputCostPerMillionTokens,
    );
  });

  it("GET /strategy/:strategyName/runs filters by status", async () => {
    // Uses "reverse-order" (untouched by every other test in this file)
    // rather than "alphabetical" — several other tests assert an exact
    // count/emptiness of alphabetical's run list for TEST_DATE, and this
    // suite shares one puzzle across all tests with no per-test cleanup.
    const puzzle = await dataSource.getRepository(Puzzle).findOneByOrFail({ date: TEST_DATE });
    const failedRun = await dataSource.getRepository(StrategyRun).save({
      puzzle,
      strategyName: "reverse-order",
      trialNumber: 203,
      status: StrategyRunStatus.FAILED,
      availableWords: [],
      currentCombination: [0, 1, 2, 3],
      finishedAt: new Date(),
    });
    await dataSource.getRepository(StrategyRun).save({
      puzzle,
      strategyName: "reverse-order",
      trialNumber: 204,
      status: StrategyRunStatus.COMPLETED,
      availableWords: [],
      currentCombination: [0, 1, 2, 3],
      finishedAt: new Date(),
    });

    const res = await request(app.getHttpServer()).get(
      "/strategy/reverse-order/runs?status=failed&limit=500",
    );

    expect(res.status).toBe(200);
    const rows = res.body.rows as Array<{ id: number; status: string }>;
    expect(rows.some((row) => row.id === failedRun.id)).toBe(true);
    expect(rows.every((row) => row.status === "failed")).toBe(true);
  });

  it("GET /strategy/activity/recent returns the most recent events across every strategy, newest first", async () => {
    // "reverse-order" again (see the status-filter test above) rather than
    // an LLM strategy/model combo — dispatch elsewhere in this suite counts
    // existing StrategyRun rows per (puzzle, model) against a trial cap, and
    // an extra ad-hoc row for a real dispatched model would push it over.
    const puzzle = await dataSource.getRepository(Puzzle).findOneByOrFail({ date: TEST_DATE });
    const newestRun = await dataSource.getRepository(StrategyRun).save({
      puzzle,
      strategyName: "reverse-order",
      trialNumber: 206,
      status: StrategyRunStatus.RUNNING,
      availableWords: [],
      currentCombination: [0, 1, 2, 3],
    });

    const res = await request(app.getHttpServer()).get("/strategy/activity/recent");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(100);
    // Just inserted, so it has the latest startedAt of everything in the
    // suite so far — the feed's own DESC ordering puts this run event first.
    expect(res.body[0]).toMatchObject({
      kind: "run",
      id: newestRun.id,
      strategyName: "reverse-order",
      modelName: null,
      trialNumber: 206,
      status: "running",
      puzzleId: puzzle.id,
      puzzleDate: TEST_DATE,
    });
  });

  it("GET /strategy/free-tier-usage/flagship reports today's usage against the 250k flagship budget", async () => {
    const res = await request(app.getHttpServer()).get("/strategy/free-tier-usage/flagship");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tier: "flagship",
      usedTokens: expect.any(Number),
      dailyLimitTokens: 250_000,
      remainingTokens: expect.any(Number),
      models: expect.arrayContaining(["gpt-5.4", "gpt-4.1", "gpt-4o", "o1", "o3"]),
    });
    expect(res.body.remainingTokens).toBe(
      Math.max(0, res.body.dailyLimitTokens - res.body.usedTokens),
    );
  });

  it("GET /strategy/free-tier-usage/mini reports today's usage against the 2.5M mini-tier budget", async () => {
    const res = await request(app.getHttpServer()).get("/strategy/free-tier-usage/mini");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tier: "mini",
      usedTokens: expect.any(Number),
      dailyLimitTokens: 2_500_000,
      remainingTokens: expect.any(Number),
      models: expect.arrayContaining(["gpt-4.1-mini", "gpt-4o-mini", "o3-mini", "o4-mini", "gpt-5-nano"]),
    });
    expect(res.body.remainingTokens).toBe(
      Math.max(0, res.body.dailyLimitTokens - res.body.usedTokens),
    );
    // The two programs are disjoint — a flagship-only model name must never
    // show up under the mini budget's model list.
    expect(res.body.models).not.toContain("gpt-5.4");
    expect(res.body.models).not.toContain("gpt-4.1");
    expect(res.body.models).not.toContain("o3");
  });

  it("POST /dispatch/strategy/:strategy/:date queues a deterministic strategy", async () => {
    const res = await request(app.getHttpServer()).post(
      `/dispatch/strategy/alphabetical/${TEST_DATE}`,
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      message: `Jobs queued for strategy 'alphabetical' on puzzle date ${TEST_DATE}`,
      puzzleId: expect.any(Number),
      date: TEST_DATE,
      strategyName: "alphabetical",
    });
  });

  it("POST /dispatch/strategy/llm-openai/:date rejects the LLM strategies", async () => {
    const res = await request(app.getHttpServer()).post(
      `/dispatch/strategy/llm-openai/${TEST_DATE}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("does not accept the LLM strategies");
  });

  it("POST /dispatch/model/:modelName/:date resolves the strategy from SupportedModel and queues a trial", async () => {
    const res = await request(app.getHttpServer()).post(
      `/dispatch/model/gpt-4.1-nano/${TEST_DATE}`,
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      message:
        "Jobs queued for model 'gpt-4.1-nano' (strategy 'llm-openai')" +
        ` on puzzle date ${TEST_DATE}`,
      puzzleId: expect.any(Number),
      date: TEST_DATE,
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano",
    });

    for (const trialNumber of [1, 2, 3]) {
      await llmOpenAIQueue.remove(`run-${res.body.puzzleId}-llm-openai-${trialNumber}`);
    }
  });

  it("POST /dispatch/model/:modelName/:date rejects an unknown or unsupported model", async () => {
    const res = await request(app.getHttpServer()).post(
      `/dispatch/model/gpt-3.5-turbo/${TEST_DATE}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("is not a supported model");
  });

  it("POST /dispatch/model/:modelName/runs/:n queues n randomly chosen unrun puzzle dates for the model", async () => {
    // gpt-5-nano is a real supported model (see the catalog test above) but
    // hasn't been dispatched anywhere else in this suite, so any puzzle date
    // it comes back with is fair game — selection is random, so the test
    // can't assume which date gets picked, only that exactly one does.
    const res = await request(app.getHttpServer()).post("/dispatch/model/gpt-5-nano/runs/1");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      strategyName: "llm-openai",
      modelName: "gpt-5-nano",
    });
    expect(res.body.dates).toHaveLength(1);

    const puzzle = await dataSource
      .getRepository(Puzzle)
      .findOneByOrFail({ date: res.body.dates[0] });
    for (const trialNumber of [1, 2, 3, 4]) {
      await llmOpenAIQueue.remove(`run-${puzzle.id}-llm-openai-${trialNumber}`);
    }
  });

  it("POST /dispatch/model/:modelName/runs/:n rejects when fewer than n unrun dates exist", async () => {
    const res = await request(app.getHttpServer()).post(
      "/dispatch/model/gpt-5-nano/runs/1000000",
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("puzzle date(s) exist");
  });

  it("POST /category-evaluation/dispatch enqueues judge jobs for un-evaluated successful proposals", async () => {
    const res = await request(app.getHttpServer()).post("/category-evaluation/dispatch?limit=2");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      message: expect.stringContaining("category-evaluation job(s)"),
      enqueued: expect.any(Number),
      llmProposalIds: expect.any(Array),
    });
    expect(res.body.enqueued).toBe(res.body.llmProposalIds.length);
    expect(res.body.enqueued).toBeLessThanOrEqual(2);

    // Drop whatever judge jobs this queued so they don't linger in the
    // shared test Redis (the e2e suite runs no worker to drain them).
    for (const id of res.body.llmProposalIds as number[]) {
      await llmOpenAIQueue.remove(`cat-eval-${id}`);
    }
  });

  it("GET /category-evaluation/coverage reports eligible/judged/pending totals", async () => {
    const res = await request(app.getHttpServer()).get("/category-evaluation/coverage");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      eligible: expect.any(Number),
      judged: expect.any(Number),
      pending: expect.any(Number),
    });
    expect(res.body.pending).toBe(res.body.eligible - res.body.judged);
    expect(res.body.judged).toBeLessThanOrEqual(res.body.eligible);
  });

  it("DELETE /category-evaluation/run/:runId clears a run's verdicts and reports the count", async () => {
    const puzzle = await dataSource.getRepository(Puzzle).findOneByOrFail({ date: TEST_DATE });
    const run = await dataSource.getRepository(StrategyRun).save({
      puzzle,
      strategyName: "reverse-order",
      trialNumber: 208,
      status: StrategyRunStatus.COMPLETED,
      availableWords: [],
      currentCombination: [0, 1, 2, 3],
      finishedAt: new Date(),
    });

    const res = await request(app.getHttpServer()).delete(`/category-evaluation/run/${run.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      message: expect.stringContaining(`for run ${run.id}`),
      runId: run.id,
      deleted: 0,
    });
  });

  it("DELETE /category-evaluation/run/:runId 404s on an unknown run id", async () => {
    const res = await request(app.getHttpServer()).delete("/category-evaluation/run/999999999");

    expect(res.status).toBe(404);
  });

  describe("free-tier dispatch", () => {
    beforeEach(async () => {
      // This suite's tests assume genuinely fresh 'mini'/'flagship' rows —
      // deleting them (rather than just deactivating) is what makes "before
      // anything starts" true on every run, not just the first one ever
      // against this shared test database.
      await dataSource.query(
        `DELETE FROM "FreeTierDispatchState" WHERE tier IN ('mini', 'flagship')`,
      );
    });

    afterEach(async () => {
      // Drop any tick job this test queued — nothing in this describe block
      // expects a worker to ever process it (the e2e suite doesn't run
      // one), so it would otherwise just sit in this shared test Redis db
      // across runs.
      await freeTierDispatchQueue.drain(true);
    });

    it("GET /dispatch/free-tier/mini reports inactive with a null threshold before anything starts", async () => {
      const res = await request(app.getHttpServer()).get("/dispatch/free-tier/mini");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        tier: "mini",
        active: false,
        thresholdPercent: null,
        startedAt: null,
      });
    });

    it("POST /dispatch/free-tier/mini starts a cycle at the given threshold", async () => {
      const res = await request(app.getHttpServer()).post("/dispatch/free-tier/mini?threshold=75");

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ tier: "mini", active: true, thresholdPercent: 75 });
      expect(res.body.startedAt).toEqual(expect.any(String));

      const status = await request(app.getHttpServer()).get("/dispatch/free-tier/mini");
      expect(status.body).toMatchObject({ active: true, thresholdPercent: 75 });
    });

    it("POST /dispatch/free-tier/mini defaults to a 90% threshold when none is given", async () => {
      const res = await request(app.getHttpServer()).post("/dispatch/free-tier/mini");

      expect(res.status).toBe(201);
      expect(res.body.thresholdPercent).toBe(90);
    });

    it("POST /dispatch/free-tier/mini rejects starting a second cycle while one is already active", async () => {
      await request(app.getHttpServer()).post("/dispatch/free-tier/mini?threshold=50");

      const res = await request(app.getHttpServer()).post("/dispatch/free-tier/mini?threshold=80");

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("already running");
    });

    it("POST /dispatch/free-tier/mini rejects a non-integer threshold", async () => {
      const res = await request(app.getHttpServer()).post("/dispatch/free-tier/mini?threshold=87.5");

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("whole number");
    });

    it("POST /dispatch/free-tier/mini rejects a threshold outside (0, 100]", async () => {
      const tooLow = await request(app.getHttpServer()).post("/dispatch/free-tier/mini?threshold=0");
      const tooHigh = await request(app.getHttpServer()).post(
        "/dispatch/free-tier/mini?threshold=101",
      );

      expect(tooLow.status).toBe(400);
      expect(tooHigh.status).toBe(400);
    });

    it("POST /dispatch/free-tier/flagship starts its own cycle, independent of mini", async () => {
      const res = await request(app.getHttpServer()).post("/dispatch/free-tier/flagship?threshold=60");

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ tier: "flagship", active: true, thresholdPercent: 60 });

      const flagshipStatus = await request(app.getHttpServer()).get("/dispatch/free-tier/flagship");
      expect(flagshipStatus.body).toMatchObject({ active: true, thresholdPercent: 60 });

      const miniStatus = await request(app.getHttpServer()).get("/dispatch/free-tier/mini");
      expect(miniStatus.body).toMatchObject({ active: false, thresholdPercent: null });
    });

    it("POST /dispatch/free-tier/:tier rejects a tier that isn't a real free-tier program", async () => {
      const res = await request(app.getHttpServer()).post("/dispatch/free-tier/bogus?threshold=90");

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("flagship");
      expect(res.body.message).toContain("mini");
    });

    it("POST /dispatch/free-tier/both starts flagship and mini together under the same threshold", async () => {
      const res = await request(app.getHttpServer()).post("/dispatch/free-tier/both?threshold=70");

      expect(res.status).toBe(201);
      expect(res.body.flagship).toMatchObject({
        tier: "flagship",
        error: null,
        status: expect.objectContaining({ tier: "flagship", active: true, thresholdPercent: 70 }),
      });
      expect(res.body.mini).toMatchObject({
        tier: "mini",
        error: null,
        status: expect.objectContaining({ tier: "mini", active: true, thresholdPercent: 70 }),
      });

      const flagshipStatus = await request(app.getHttpServer()).get("/dispatch/free-tier/flagship");
      expect(flagshipStatus.body).toMatchObject({ active: true, thresholdPercent: 70 });
      const miniStatus = await request(app.getHttpServer()).get("/dispatch/free-tier/mini");
      expect(miniStatus.body).toMatchObject({ active: true, thresholdPercent: 70 });
    });

    it("POST /dispatch/free-tier/both reports one tier's failure without blocking the other from starting", async () => {
      await request(app.getHttpServer()).post("/dispatch/free-tier/mini?threshold=50");

      const res = await request(app.getHttpServer()).post("/dispatch/free-tier/both?threshold=70");

      expect(res.status).toBe(201);
      expect(res.body.mini.status).toBeNull();
      expect(res.body.mini.error).toContain("already running");
      expect(res.body.flagship.status).toMatchObject({ active: true, thresholdPercent: 70 });

      // Mini's pre-existing 50% cycle was untouched by the failed attempt to
      // restart it via 'both' — not silently overwritten or reset.
      const miniStatus = await request(app.getHttpServer()).get("/dispatch/free-tier/mini");
      expect(miniStatus.body).toMatchObject({ active: true, thresholdPercent: 50 });
    });

    it("DELETE /dispatch/free-tier/both stops both cycles", async () => {
      await request(app.getHttpServer()).post("/dispatch/free-tier/flagship?threshold=60");
      await request(app.getHttpServer()).post("/dispatch/free-tier/mini?threshold=60");

      const res = await request(app.getHttpServer()).delete("/dispatch/free-tier/both");

      expect(res.status).toBe(200);
      expect(res.body.flagship).toMatchObject({ tier: "flagship", active: false });
      expect(res.body.mini).toMatchObject({ tier: "mini", active: false });

      const flagshipStatus = await request(app.getHttpServer()).get("/dispatch/free-tier/flagship");
      expect(flagshipStatus.body.active).toBe(false);
      const miniStatus = await request(app.getHttpServer()).get("/dispatch/free-tier/mini");
      expect(miniStatus.body.active).toBe(false);
    });

    it("DELETE /dispatch/free-tier/both on already-inactive tiers is a harmless no-op", async () => {
      const res = await request(app.getHttpServer()).delete("/dispatch/free-tier/both");

      expect(res.status).toBe(200);
      expect(res.body.flagship.active).toBe(false);
      expect(res.body.mini.active).toBe(false);
    });

    it("DELETE /dispatch/free-tier/mini stops an active cycle", async () => {
      await request(app.getHttpServer()).post("/dispatch/free-tier/mini?threshold=90");

      const res = await request(app.getHttpServer()).delete("/dispatch/free-tier/mini");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ active: false });

      const status = await request(app.getHttpServer()).get("/dispatch/free-tier/mini");
      expect(status.body.active).toBe(false);
    });

    it("DELETE /dispatch/free-tier/mini on an already-inactive tier is a harmless no-op", async () => {
      const res = await request(app.getHttpServer()).delete("/dispatch/free-tier/mini");

      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
    });
  });

  it("GET /strategy/:strategy/puzzle/:date returns an empty run list", async () => {
    const res = await request(app.getHttpServer()).get(
      `/strategy/alphabetical/puzzle/${TEST_DATE}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("paginates strategy run detail guesses", async () => {
    const puzzle = await dataSource.getRepository(Puzzle).findOneByOrFail({ date: TEST_DATE });
    const run = await dataSource.getRepository(StrategyRun).save({
      puzzle,
      strategyName: "alphabetical",
      trialNumber: 0,
      availableWords: ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"],
      currentCombination: [0, 1, 2, 3],
    });
    await dataSource.getRepository(Guess).save([
      {
        puzzle,
        strategyRun: run,
        words: ["AAAA", "BBBB", "CCCC", "DDDD"],
        result: GuessResult.SUCCESS,
        sequenceNumber: 1,
        source: GuessSource.STRATEGY,
      },
      {
        puzzle,
        strategyRun: run,
        words: ["EEEE", "FFFF", "GGGG", "HHHH"],
        result: GuessResult.SUCCESS,
        sequenceNumber: 2,
        source: GuessSource.STRATEGY,
      },
    ]);

    const res = await request(app.getHttpServer()).get(
      `/strategy/alphabetical/puzzle/${TEST_DATE}/run/0?page=2&limit=1`,
    );

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 2, page: 2, limit: 1 });
    expect(res.body.guesses).toEqual([
      {
        sequenceNumber: 2,
        words: ["EEEE", "FFFF", "GGGG", "HHHH"],
        result: "success",
        guessedAt: expect.any(String),
      },
    ]);
  });

  it("GET /strategy/:strategy/puzzle/:date/run/:trialNumber/guess/:sequenceNumber returns the LLM telemetry for a single guess", async () => {
    const puzzle = await dataSource.getRepository(Puzzle).findOneByOrFail({ date: TEST_DATE });
    const run = await dataSource.getRepository(StrategyRun).save({
      puzzle,
      strategyName: "llm-openai",
      trialNumber: 0,
      availableWords: ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"],
      currentCombination: [0, 1, 2, 3],
    });
    const guess = await dataSource.getRepository(Guess).save({
      puzzle,
      strategyRun: run,
      words: ["AAAA", "BBBB", "CCCC", "DDDD"],
      result: GuessResult.SUCCESS,
      sequenceNumber: 1,
      source: GuessSource.STRATEGY,
    });

    const res = await request(app.getHttpServer()).get(
      `/strategy/llm-openai/puzzle/${TEST_DATE}/run/0/guess/1`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sequenceNumber: 1,
      words: ["AAAA", "BBBB", "CCCC", "DDDD"],
      result: "success",
      guessedAt: expect.any(String),
    });
    expect(guess.id).toBeTruthy();
  });

  it("persists every proposed LLM candidate as an LlmProposal row", async () => {
    const puzzle = await dataSource.getRepository(Puzzle).findOneByOrFail({ date: TEST_DATE });
    const llmStrategyRunner = app.get(LlmStrategyRunner);

    // Trial 99: the llm-openai trial-0 run is already created by the telemetry
    // test above, and this needs a fresh run.
    const result = await llmStrategyRunner.runLlmStrategy(puzzle.id, "llm-openai", 99);

    // The fake orchestrator always proposes the next unsolved answer group
    // (see the /solve-assist handler above), so the run solves fully.
    expect(result.status).toBe(StrategyRunStatus.COMPLETED);

    const run = await dataSource.getRepository(StrategyRun).findOneByOrFail({
      puzzleId: puzzle.id,
      strategyName: "llm-openai",
      trialNumber: 99,
    });
    const proposals = await dataSource.getRepository(LlmProposal).find({
      where: { strategyRunId: run.id },
      order: { id: "ASC" },
    });

    expect(proposals).toHaveLength(4);
    expect(proposals[0]).toMatchObject({
      category: "E2E fake",
      status: LlmProposalStatus.USED,
    });
    expect(proposals[0].words).toEqual(["AAAA", "BBBB", "CCCC", "DDDD"]);
    // The 'used' proposal links to the guess that realized it.
    expect(proposals[0].guessId).not.toBeNull();
  }, 30000);

  it("POST /api/diagnose proxies the message history to the orchestrator without persisting", async () => {
    const before = await dataSource.getRepository(LlmProposal).count();
    const res = await request(app.getHttpServer())
      .post("/api/diagnose")
      .send({
        messages: [
          {
            role: "user",
            content: "You are playing NYT Connections. The items below form 2 groups of four...",
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      orchestrator: "healthy",
      data: {
        response: "Reasoning.\nANSWER:\nAAAA, BBBB, CCCC, DDDD\nEEEE, FFFF, GGGG, HHHH",
        groups: [
          ["AAAA", "BBBB", "CCCC", "DDDD"],
          ["EEEE", "FFFF", "GGGG", "HHHH"],
        ],
        model: "e2e-fake-model",
      },
    });
    // The AI Assist flow never persists anything — guesses are only submitted
    // through the game itself in the frontend.
    const after = await dataSource.getRepository(LlmProposal).count();
    expect(after).toBe(before);
  });

  it("POST /api/diagnose rejects an invalid body", async () => {
    const res = await request(app.getHttpServer()).post("/api/diagnose").send({ messages: [] });

    expect(res.status).toBe(400);
  });

  it("rejects non-whitelisted body fields", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/diagnose")
      .send({
        messages: [{ role: "user", content: "hi" }],
        sneaky: "extra",
      });

    expect(res.status).toBe(400);
  });

  it("redirects an unauthenticated Bull Board request to the login page", async () => {
    const unauthenticated = await request(app.getHttpServer()).get("/bull/queues");
    expect(unauthenticated.status).toBe(302);
    expect(unauthenticated.headers.location).toBe("/bull/login");
  });

  it("rejects a login attempt with the wrong password", async () => {
    const failedLogin = await request(app.getHttpServer())
      .post("/bull/login")
      .type("form")
      .send({ username: "test-user", password: "wrong-pass" });

    expect(failedLogin.status).toBe(401);
    expect(failedLogin.headers["set-cookie"]).toBeUndefined();
  });

  it("logs in with a valid session cookie and reaches Bull Board", async () => {
    const login = await request(app.getHttpServer())
      .post("/bull/login")
      .type("form")
      .send({ username: "test-user", password: "test-pass" });

    expect(login.status).toBe(302);
    expect(login.headers.location).toBe("/bull/queues");
    const cookie = login.headers["set-cookie"]?.[0];
    expect(cookie).toContain("HttpOnly");

    const authorized = await request(app.getHttpServer())
      .get("/bull/queues")
      .set("Cookie", cookie);
    expect(authorized.status).toBe(200);
  });
});
