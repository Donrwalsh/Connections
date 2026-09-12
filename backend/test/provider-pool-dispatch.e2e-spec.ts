import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Server } from "http";
import * as http from "http";
import { DataSource } from "typeorm";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { AnswerGroup } from "../src/modules/game/entities/answer-group.entity";
import { GroupMember } from "../src/modules/game/entities/group-member.entity";
import { Puzzle } from "../src/modules/game/entities/puzzle.entity";
import { SupportedModel } from "../src/modules/supported-model/entities/supported-model.entity";
import { StrategyRun, StrategyRunStatus } from "../src/modules/strategy/entities/strategy-run.entity";
import { RateLimitHold } from "../src/modules/strategy/entities/rate-limit-hold.entity";
import { LlmStrategyRunner } from "../src/modules/strategy/llm-strategy-runner.service";
import { RpdResumeService } from "../src/modules/provider-pool/rpd-resume.service";
import { FreeDispatchService } from "../src/modules/provider-pool/free-dispatch.service";
import { llmGroqQueue } from "../src/modules/queue/strategy.queue";

/**
 * End-to-end proof that the unified provider-pool machinery holds together
 * against a real Postgres + Redis: the config-driven strategy runner writes
 * a per-model rate-limit hold, the generic RpdResumeService clears an
 * expired hold and revives the parked run, and the generic
 * FreeDispatchService reads the unified DispatchState table. Uses a loopback
 * fake orchestrator on :3999 (ORCHESTRATOR_URL already points there via
 * test/setup-env.ts) so zero real provider calls happen; REDIS_DB=15 keeps
 * any enqueued job out of every live worker's keyspace.
 */
const TEST_DATE = "1999-12-30";
const GROQ_MODEL = "e2e/groq-model";
const GROUPS = [
  ["AAAA", "BBBB", "CCCC", "DDDD"],
  ["EEEE", "FFFF", "GGGG", "HHHH"],
  ["IIII", "JJJJ", "KKKK", "LLLL"],
  ["MMMM", "NNNN", "OOOO", "PPPP"],
];

describe("Provider pool dispatch (e2e)", () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let orchestrator: Server;
  let puzzleId: number;

  beforeAll(async () => {
    // Fake orchestrator: every /solve-step is a 429 daily-quota hit, so the
    // runner parks the run and the config-driven path writes the hold.
    orchestrator = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/solve-step" && req.method === "POST") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "daily quota exhausted",
              code: "rate_limited_daily",
              details: { dailyResetSeconds: 7200 },
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

    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await configureApp(app);
    await app.init();
    dataSource = app.get(DataSource);
    // Idempotent — applies 1800000000000-unify-dispatch-state if this test DB
    // has not seen it yet; already-run migrations are skipped.
    await dataSource.runMigrations();

    await cleanup();
    await seed();
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await app.close();
    await new Promise<void>((resolve) => orchestrator.close(() => resolve()));
  }, 60000);

  async function seed(): Promise<void> {
    const puzzle = await dataSource.getRepository(Puzzle).save({ date: TEST_DATE });
    puzzleId = puzzle.id;
    for (const [groupIndex, words] of GROUPS.entries()) {
      const group = await dataSource
        .getRepository(AnswerGroup)
        .save({ puzzle, level: groupIndex, group_name: `G${groupIndex}` });
      await dataSource.getRepository(GroupMember).save(
        words.map((word, position) => ({ group, word, position: groupIndex * 4 + position })),
      );
    }
    await dataSource
      .getRepository(SupportedModel)
      .save({ strategyName: "llm-groq", modelName: GROQ_MODEL, supported: true });
  }

  async function cleanup(): Promise<void> {
    await dataSource.query(`DELETE FROM "RateLimitHold" WHERE "strategyName" = 'llm-groq'`);
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
    await dataSource.query(
      `DELETE FROM "SupportedModel" WHERE "strategyName" = 'llm-groq' AND "modelName" = '${GROQ_MODEL}'`,
    );
    await llmGroqQueue.drain(true).catch(() => undefined);
  }

  it("reads the unified DispatchState table through the generic FreeDispatchService", async () => {
    const dispatch = app.get(FreeDispatchService);

    // Until-held pool: active/startedAt only.
    await expect(dispatch.getStatus("groq")).resolves.toEqual({ active: false, startedAt: null });

    // Account-budget pool: the extra callsToday / dailyBudget fields.
    const openrouter = await dispatch.getStatus("openrouter");
    expect(openrouter).toMatchObject({ active: false, startedAt: null });
    expect(typeof openrouter.callsToday).toBe("number");
    expect(typeof openrouter.dailyBudget).toBe("number");
  });

  it("parks an llm-groq run and writes a per-model hold via the config-driven path", async () => {
    const runner = app.get(LlmStrategyRunner);

    const result = await runner.runLlmStrategy(puzzleId, "llm-groq", 0, GROQ_MODEL);

    expect(result.status).toBe(StrategyRunStatus.RATE_LIMITED_DAILY);

    const hold = await dataSource
      .getRepository(RateLimitHold)
      .findOne({ where: { strategyName: "llm-groq", modelName: GROQ_MODEL } });
    expect(hold).not.toBeNull();
    const secondsOut = (hold!.resetAt.getTime() - Date.now()) / 1000;
    expect(secondsOut).toBeGreaterThan(7000);
    expect(secondsOut).toBeLessThan(7300);
  }, 30000);

  it("clears an expired hold and revives the parked run through RpdResumeService", async () => {
    const runRepo = dataSource.getRepository(StrategyRun);
    const holdRepo = dataSource.getRepository(RateLimitHold);

    // The run is parked from the previous test; force its hold to have
    // already elapsed, as the real reset would.
    await holdRepo.update(
      { strategyName: "llm-groq", modelName: GROQ_MODEL },
      { resetAt: new Date(Date.now() - 60_000) },
    );

    const result = await app.get(RpdResumeService).runResume("groq", "e2e-sweep");

    expect(result.cleared).toEqual([GROQ_MODEL]);
    expect(result.redispatched).toBe(1);

    const revived = await runRepo.findOneOrFail({
      where: { puzzleId, strategyName: "llm-groq", trialNumber: 0 },
    });
    expect(revived.status).toBe(StrategyRunStatus.RUNNING);

    expect(
      await holdRepo.findOne({ where: { strategyName: "llm-groq", modelName: GROQ_MODEL } }),
    ).toBeNull();

    // Re-dispatched onto the real runs queue under a resume-stamped id.
    const job = await llmGroqQueue.getJob(`run-${puzzleId}-llm-groq-0-resume-e2e-sweep`);
    expect(job).toBeDefined();
  }, 30000);
});
