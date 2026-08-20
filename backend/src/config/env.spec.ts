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

  describe("DISPATCH_PASSWORD", () => {
    it("should default to an empty string outside production", () => {
      expect(loadEnv(baseEnv).DISPATCH_PASSWORD).toBe("");
    });

    it("should pass through a configured value", () => {
      expect(loadEnv({ ...baseEnv, DISPATCH_PASSWORD: "secret" }).DISPATCH_PASSWORD).toBe("secret");
    });

    it("should fail closed when NODE_ENV=production and unset", () => {
      expect(() => loadEnv({ ...baseEnv, NODE_ENV: "production" })).toThrow(/DISPATCH_PASSWORD/);
    });

    it("should boot fine in production once DISPATCH_PASSWORD is set", () => {
      expect(
        loadEnv({ ...baseEnv, NODE_ENV: "production", DISPATCH_PASSWORD: "secret" }).DISPATCH_PASSWORD,
      ).toBe("secret");
    });
  });
});
