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
import { StrategyRun } from "../src/modules/strategy/entities/strategy-run.entity";
import { strategyQueue } from "../src/modules/queue/strategy.queue";

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
    // Stand-in for the real orchestrator service so /api/solve is testable
    // without an OpenAI key.
    orchestrator = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/solve" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              proposedGroups: [
                {
                  word_ids: [0, 1, 2, 3],
                  category: "Test category",
                  confidence: 0.99,
                  reasoning: "E2E fake",
                },
              ],
              prompt: `echo: ${body}`,
              model: "e2e-fake-model",
              contextWindow: 8192,
              latencyMs: 42,
              usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            }),
          );
        } else if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok" }));
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

    for (const group of TEST_GROUPS) {
      const answerGroup = await dataSource.getRepository(AnswerGroup).save({
        puzzle,
        level: group.level,
        group_name: group.name,
      });
      await dataSource.getRepository(GroupMember).save(
        group.words.map((word, position) => ({
          group: answerGroup,
          word,
          position,
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

  it("POST /strategy/queue/llm/:date queues a single llm trial-0 job", async () => {
    const res = await request(app.getHttpServer()).post(`/strategy/queue/llm/${TEST_DATE}`);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      message: `LLM job queued for puzzle date ${TEST_DATE}`,
      puzzleId: expect.any(Number),
      date: TEST_DATE,
      strategyName: "llm",
      trialNumber: 0,
    });

    await strategyQueue.remove(`run-${res.body.puzzleId}-llm-0`);
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

  it("POST /api/solve proxies to the orchestrator", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/solve")
      .send({ puzzleWords: ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"] });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      orchestrator: "healthy",
      data: {
        proposedGroups: [expect.objectContaining({ word_ids: [0, 1, 2, 3] })],
        prompt: expect.any(String),
        model: "e2e-fake-model",
        contextWindow: 8192,
        latencyMs: 42,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
    });
  });

  it("POST /api/solve rejects an invalid body", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/solve")
      .send({ puzzleWords: ["too", "few"] });

    expect(res.status).toBe(400);
  });

  it("rejects non-whitelisted body fields", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/solve")
      .send({
        puzzleWords: ["AAAA", "BBBB", "CCCC", "DDDD"],
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
