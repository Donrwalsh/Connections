import { readFileSync } from "fs";
import { resolve } from "path";

import {
  llmGoogleRateLimitFallbackSeconds,
  llmGroqDailyHoldFallbackSeconds,
  llmGroqRateLimitFallbackSeconds,
  llmMistralRateLimitFallbackSeconds,
  llmOpenRouterRateLimitFallbackSeconds,
  llmSambaNovaDailyHoldFallbackSeconds,
  llmSambaNovaRateLimitFallbackSeconds,
  mistralModelHoldFallbackSeconds,
  mistralPersistentRateLimitAttempts,
  mistralPersistentRateLimitElapsedMs,
  openRouterCallsPerTrialEstimate,
  openRouterDispatchMaxBatch,
  openRouterDispatchMaxInFlight,
  openRouterDispatchRpmCooldownSeconds,
  openRouterDispatchTickMs,
  openRouterFreeDailyBudget,
  sambaNovaDispatchMaxBatch,
  sambaNovaDispatchMaxInFlight,
  sambaNovaDispatchTickMs,
} from "../../strategies";
import {
  FREE_TIER_POOLS,
  PROVIDER_POOLS,
  providerPool,
  providerPoolById,
  providerPoolOrThrow,
  type ProviderPool,
} from "./provider-pool.config";

const FREE_TIER_IDS = ["google", "groq", "openrouter", "mistral", "sambanova"];
const NON_FREE_TIER_IDS = ["openai", "ollama"];

const byId = (id: string): ProviderPool => {
  const pool = PROVIDER_POOLS.find((p) => p.id === id);
  if (!pool) throw new Error(`no pool ${id} in test setup`);
  return pool;
};

describe("PROVIDER_POOLS row shape", () => {
  it("has exactly the seven known pools, in burn order then non-free-tier", () => {
    expect(PROVIDER_POOLS.map((p) => p.id)).toEqual([
      "google",
      "groq",
      "openrouter",
      "mistral",
      "sambanova",
      "openai",
      "ollama",
    ]);
  });

  it.each(PROVIDER_POOLS.map((p) => [p.id, p] as const))(
    "%s: id / strategyName / orchestratorProvider / runs queue follow the naming convention",
    (id, pool) => {
      expect(pool.label).toMatch(/\S/);
      expect(pool.strategyName).toBe(`llm-${id}`);
      expect(pool.orchestratorProvider).toBe(id);
      expect(pool.queues.runs).toBe(`llm-${id}-runs`);
    },
  );

  it.each(FREE_TIER_IDS)("%s: is a free-tier pool with dispatch + resume queues", (id) => {
    const pool = byId(id);
    expect(pool.freeTier).not.toBeNull();
    expect(pool.queues.freeDispatch).toBe(`${id}-free-dispatch`);
    expect(pool.queues.rpdResume).toBe(`${id}-rpd-resume`);
  });

  it.each(NON_FREE_TIER_IDS)("%s: has no free-tier machinery", (id) => {
    const pool = byId(id);
    expect(pool.freeTier).toBeNull();
    expect(pool.queues.freeDispatch).toBeUndefined();
    expect(pool.queues.rpdResume).toBeUndefined();
  });
});

describe("FreeTierConfig invariants", () => {
  const freeTierRows = FREE_TIER_IDS.map((id) => [id, byId(id).freeTier!] as const);

  it.each(freeTierRows)("%s: holdScope is model or account", (_id, freeTier) => {
    expect(["model", "account"]).toContain(freeTier.holdScope);
  });

  it.each(freeTierRows)("%s: resetSchedule discriminant is well formed", (_id, freeTier) => {
    const schedule = freeTier.resetSchedule;
    if (schedule.kind === "fixed-cron") {
      expect(schedule.pattern).toMatch(/\S/);
      expect(schedule.tz).toMatch(/\S/);
    } else if (schedule.kind === "self-rearm") {
      expect(schedule.maxDelayMs).toBeGreaterThan(0);
    } else {
      throw new Error(`unknown resetSchedule kind: ${JSON.stringify(schedule)}`);
    }
  });

  it.each(freeTierRows)(
    "%s: rateLimitFallbackSeconds and dailyHoldFallbackSeconds resolve to positive numbers",
    (_id, freeTier) => {
      for (const value of [freeTier.rateLimitFallbackSeconds(), freeTier.dailyHoldFallbackSeconds()]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    },
  );

  it.each(freeTierRows)("%s: dispatch spec is well formed and its thunks resolve", (_id, freeTier) => {
    const dispatch = freeTier.dispatch;
    if (dispatch.stop === "until-held") {
      if (dispatch.pacing !== "shared") {
        for (const thunk of [dispatch.pacing.tickMs, dispatch.pacing.maxBatch, dispatch.pacing.maxInFlight]) {
          expect(thunk()).toBeGreaterThan(0);
        }
      }
    } else if (dispatch.stop === "account-budget") {
      for (const thunk of [
        dispatch.budget,
        dispatch.callsPerTrial,
        dispatch.rpmCooldownSeconds,
        dispatch.tickMs,
        dispatch.maxBatch,
        dispatch.maxInFlight,
      ]) {
        expect(Number.isFinite(thunk())).toBe(true);
        expect(thunk()).toBeGreaterThan(0);
      }
    } else {
      throw new Error(`unknown dispatch stop: ${JSON.stringify(dispatch)}`);
    }
  });

  it("only Mistral carries persistentRateLimitPark", () => {
    for (const id of FREE_TIER_IDS) {
      const present = typeof byId(id).freeTier!.persistentRateLimitPark === "object";
      expect(present).toBe(id === "mistral");
    }
    const park = byId("mistral").freeTier!.persistentRateLimitPark!;
    expect(park.attempts()).toBeGreaterThan(0);
    expect(park.elapsedMs()).toBeGreaterThan(0);
  });
});

describe("per-pool concrete configuration", () => {
  it("google: per-model hold, Pacific-midnight cron, shared until-held dispatch", () => {
    expect(byId("google").freeTier).toMatchObject({
      holdScope: "model",
      resetSchedule: { kind: "fixed-cron", pattern: "1 0 * * *", tz: "America/Los_Angeles" },
      dispatch: { stop: "until-held", pacing: "shared" },
    });
  });

  it("groq: per-model hold, self-rearm (15m cap), shared until-held dispatch", () => {
    expect(byId("groq").freeTier).toMatchObject({
      holdScope: "model",
      resetSchedule: { kind: "self-rearm", maxDelayMs: 15 * 60_000 },
      dispatch: { stop: "until-held", pacing: "shared" },
    });
  });

  it("openrouter: account-wide hold, UTC-midnight cron, account-budget dispatch", () => {
    const freeTier = byId("openrouter").freeTier!;
    expect(freeTier.holdScope).toBe("account");
    expect(freeTier.resetSchedule).toEqual({ kind: "fixed-cron", pattern: "5 0 * * *", tz: "UTC" });
    expect(freeTier.dispatch.stop).toBe("account-budget");
  });

  it("mistral: per-model hold, self-rearm, shared until-held dispatch, streak park", () => {
    expect(byId("mistral").freeTier).toMatchObject({
      holdScope: "model",
      resetSchedule: { kind: "self-rearm", maxDelayMs: 15 * 60_000 },
      dispatch: { stop: "until-held", pacing: "shared" },
    });
  });

  it("sambanova: per-model hold, self-rearm, dedicated-pacing until-held dispatch", () => {
    const freeTier = byId("sambanova").freeTier!;
    expect(freeTier.holdScope).toBe("model");
    expect(freeTier.resetSchedule).toEqual({ kind: "self-rearm", maxDelayMs: 15 * 60_000 });
    expect(freeTier.dispatch.stop).toBe("until-held");
    if (freeTier.dispatch.stop === "until-held") {
      expect(freeTier.dispatch.pacing).not.toBe("shared");
    }
  });
});

describe("knob accessors are wired to the right provider", () => {
  // Guards against copy-paste errors like pointing groq's row at google's fn.
  it.each([
    ["google", "rateLimitFallbackSeconds", llmGoogleRateLimitFallbackSeconds],
    ["groq", "rateLimitFallbackSeconds", llmGroqRateLimitFallbackSeconds],
    ["groq", "dailyHoldFallbackSeconds", llmGroqDailyHoldFallbackSeconds],
    ["openrouter", "rateLimitFallbackSeconds", llmOpenRouterRateLimitFallbackSeconds],
    ["mistral", "rateLimitFallbackSeconds", llmMistralRateLimitFallbackSeconds],
    ["mistral", "dailyHoldFallbackSeconds", mistralModelHoldFallbackSeconds],
    ["sambanova", "rateLimitFallbackSeconds", llmSambaNovaRateLimitFallbackSeconds],
    ["sambanova", "dailyHoldFallbackSeconds", llmSambaNovaDailyHoldFallbackSeconds],
  ] as const)("%s.%s", (id, key, fn) => {
    expect(byId(id).freeTier![key]).toBe(fn);
  });

  it("mistral streak park points at the mistral persistent-rate-limit knobs", () => {
    const park = byId("mistral").freeTier!.persistentRateLimitPark!;
    expect(park.attempts).toBe(mistralPersistentRateLimitAttempts);
    expect(park.elapsedMs).toBe(mistralPersistentRateLimitElapsedMs);
  });

  it("openrouter account-budget dispatch points at the openrouter knobs", () => {
    const dispatch = byId("openrouter").freeTier!.dispatch;
    if (dispatch.stop !== "account-budget") throw new Error("expected account-budget");
    expect(dispatch.budget).toBe(openRouterFreeDailyBudget);
    expect(dispatch.callsPerTrial).toBe(openRouterCallsPerTrialEstimate);
    expect(dispatch.rpmCooldownSeconds).toBe(openRouterDispatchRpmCooldownSeconds);
    expect(dispatch.tickMs).toBe(openRouterDispatchTickMs);
    expect(dispatch.maxBatch).toBe(openRouterDispatchMaxBatch);
    expect(dispatch.maxInFlight).toBe(openRouterDispatchMaxInFlight);
  });

  it("sambanova dedicated pacing points at the sambanova knobs", () => {
    const dispatch = byId("sambanova").freeTier!.dispatch;
    if (dispatch.stop !== "until-held" || dispatch.pacing === "shared") {
      throw new Error("expected dedicated pacing");
    }
    expect(dispatch.pacing.tickMs).toBe(sambaNovaDispatchTickMs);
    expect(dispatch.pacing.maxBatch).toBe(sambaNovaDispatchMaxBatch);
    expect(dispatch.pacing.maxInFlight).toBe(sambaNovaDispatchMaxInFlight);
  });
});

describe("lookups", () => {
  it("providerPool resolves a known strategy to its row", () => {
    expect(providerPool("llm-groq")).toBe(byId("groq"));
    expect(providerPool("llm-openai")).toBe(byId("openai"));
  });

  it("providerPool returns null for non-pool and unknown strategies", () => {
    expect(providerPool("llm-deterministic")).toBeNull();
    expect(providerPool("deterministic")).toBeNull();
    expect(providerPool("shuffle")).toBeNull();
    expect(providerPool("totally-unknown")).toBeNull();
  });

  it("providerPool returns null for empty / nullish input", () => {
    expect(providerPool("")).toBeNull();
    expect(providerPool(null)).toBeNull();
    expect(providerPool(undefined)).toBeNull();
  });

  it("providerPoolOrThrow returns the row or throws with the strategy name", () => {
    expect(providerPoolOrThrow("llm-mistral")).toBe(byId("mistral"));
    expect(() => providerPoolOrThrow("llm-nope")).toThrow(/llm-nope/);
  });

  it("providerPoolById returns the row or throws with the id", () => {
    expect(providerPoolById("sambanova")).toBe(byId("sambanova"));
    // @ts-expect-error — exercising the runtime guard with a bad id
    expect(() => providerPoolById("nope")).toThrow(/nope/);
  });

  it("FREE_TIER_POOLS is the five free-tier rows in burn order", () => {
    expect(FREE_TIER_POOLS.map((p) => p.id)).toEqual(FREE_TIER_IDS);
    for (const pool of FREE_TIER_POOLS) {
      expect(pool.freeTier).not.toBeNull();
    }
  });
});

describe("frontend parity", () => {
  // The frontend list (frontend/src/data/benchmark/providerPools.ts) is the UI
  // filter list; this backend list is the behaviour config. They must agree on
  // the shared id / strategyName columns. Read as text to avoid importing
  // frontend code into the backend build.
  it("shares the same {id, strategyName} pairs as the frontend PROVIDER_POOLS", () => {
    const frontendFile = resolve(
      __dirname,
      "../../../..",
      "frontend/src/data/benchmark/providerPools.ts",
    );
    const source = readFileSync(frontendFile, "utf8");
    const rowRe = /id:\s*"([^"]+)"\s*,\s*label:\s*"[^"]*"\s*,\s*strategyName:\s*"([^"]+)"/g;

    const frontendPairs = new Set<string>();
    for (let m = rowRe.exec(source); m !== null; m = rowRe.exec(source)) {
      frontendPairs.add(`${m[1]}=${m[2]}`);
    }
    const backendPairs = new Set(PROVIDER_POOLS.map((p) => `${p.id}=${p.strategyName}`));

    expect(frontendPairs.size).toBe(PROVIDER_POOLS.length);
    expect([...backendPairs].sort()).toEqual([...frontendPairs].sort());
  });
});
