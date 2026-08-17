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
  LlmProposal,
  LlmProposalStatus,
} from "../src/modules/strategy/entities/llm-proposal.entity";
import {
  StrategyRun,
  StrategyRunStatus,
} from "../src/modules/strategy/entities/strategy-run.entity";
import { LlmStrategyRunner } from "../src/modules/strategy/llm-strategy-runner.service";
import { llmOpenAIQueue } from "../src/modules/queue/strategy.queue";

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
      // Drain the request body so "end" fires — none of the canned responses
      // below need its contents.
      req.on("data", () => {});
      req.on("end", () => {
        if (req.url === "/solve-assist" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              response: "ANSWER:\nAAAA, BBBB, CCCC, DDDD\nEEEE, FFFF, GGGG, HHHH",
              groups: [
                ["AAAA", "BBBB", "CCCC", "DDDD"],
                ["EEEE", "FFFF", "GGGG", "HHHH"],
              ],
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

  it("POST /strategy/queue/llm-openai/:date queues one trial job per configured trial", async () => {
    const res = await request(app.getHttpServer()).post(`/strategy/queue/llm-openai/${TEST_DATE}`);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      message: `Jobs queued for strategy 'llm-openai' on puzzle date ${TEST_DATE}`,
      puzzleId: expect.any(Number),
      date: TEST_DATE,
      strategyName: "llm-openai",
    });

    for (const trialNumber of res.body.trialNumbers ?? [1, 2, 3]) {
      await llmOpenAIQueue.remove(`run-${res.body.puzzleId}-llm-openai-${trialNumber}`);
    }
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

    // The fake orchestrator always proposes group [0, 1, 2, 3], which resolves
    // to the next unsolved answer group on every step, so the run solves fully.
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
      reasoning: "E2E fake",
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

  it("locks Bull Board behind basic auth", async () => {
    const unauthorized = await request(app.getHttpServer()).get("/admin/queues");
    expect(unauthorized.status).toBe(401);

    const creds = Buffer.from("test-user:test-pass").toString("base64");
    const authorized = await request(app.getHttpServer())
      .get("/admin/queues")
      .set("Authorization", `Basic ${creds}`);
    expect(authorized.status).toBe(200);
  });
});
