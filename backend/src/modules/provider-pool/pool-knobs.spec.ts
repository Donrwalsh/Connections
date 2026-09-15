import { intEnv, msEnvAsSeconds, secondsEnvAsMs } from "./pool-knobs";

describe("intEnv", () => {
  it("returns the fallback when the var is missing", () => {
    expect(intEnv("NOPE_VAR", 7, {})).toBe(7);
  });

  it("returns the fallback when the var is non-numeric, zero, or negative", () => {
    expect(intEnv("X", 7, { X: "abc" })).toBe(7);
    expect(intEnv("X", 7, { X: "0" })).toBe(7);
    expect(intEnv("X", 7, { X: "-3" })).toBe(7);
  });

  it("returns the parsed value when it is a positive integer", () => {
    expect(intEnv("X", 7, { X: "42" })).toBe(42);
  });

  it("defaults to process.env when no env object is passed", () => {
    const prior = process.env.POOL_KNOBS_TEST_VAR;
    process.env.POOL_KNOBS_TEST_VAR = "9";
    try {
      expect(intEnv("POOL_KNOBS_TEST_VAR", 1)).toBe(9);
    } finally {
      if (prior === undefined) delete process.env.POOL_KNOBS_TEST_VAR;
      else process.env.POOL_KNOBS_TEST_VAR = prior;
    }
  });
});

describe("msEnvAsSeconds", () => {
  it("reads a milliseconds env var and rounds up to whole seconds", () => {
    expect(msEnvAsSeconds("X", 60_000, { X: "1500" })).toBe(2);
    expect(msEnvAsSeconds("X", 60_000, { X: "2000" })).toBe(2);
  });

  it("falls back to the millisecond default, converted to seconds", () => {
    expect(msEnvAsSeconds("X", 60_000, {})).toBe(60);
  });
});

describe("secondsEnvAsMs", () => {
  it("reads a seconds env var and returns milliseconds", () => {
    expect(secondsEnvAsMs("X", 300, { X: "42" })).toBe(42_000);
  });

  it("falls back to the seconds default, converted to milliseconds", () => {
    expect(secondsEnvAsMs("X", 300, {})).toBe(300_000);
  });
});
