import { loadEnv } from "./env";

const baseEnv = { INTERNAL_API_KEY: "test-key" };

describe("loadEnv", () => {
  describe("DB_MIGRATIONS_RUN", () => {
    it("should default to true when unset", () => {
      expect(loadEnv(baseEnv).DB_MIGRATIONS_RUN).toBe(true);
    });

    it("should be false only for the literal string 'false'", () => {
      expect(loadEnv({ ...baseEnv, DB_MIGRATIONS_RUN: "false" }).DB_MIGRATIONS_RUN).toBe(false);
      expect(loadEnv({ ...baseEnv, DB_MIGRATIONS_RUN: "0" }).DB_MIGRATIONS_RUN).toBe(true);
      expect(loadEnv({ ...baseEnv, DB_MIGRATIONS_RUN: "anything" }).DB_MIGRATIONS_RUN).toBe(true);
    });
  });
});
