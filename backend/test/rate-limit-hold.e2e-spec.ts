import { AppDataSource } from "../src/data-source";

/**
 * Proves the two uniqueness guarantees on the unified "RateLimitHold" table
 * that a mock-repository unit test cannot reach (see
 * 1798000000000-unify-rate-limit-hold.ts):
 *
 *   - the composite UNIQUE (strategyName, modelName) still blocks a duplicate
 *     per-model hold;
 *   - the partial unique index "UQ_RateLimitHold_strategy_account" pins each
 *     strategy to a single account-wide (modelName IS NULL) row, which the
 *     composite constraint alone does NOT do because Postgres treats NULLs as
 *     distinct;
 *   - a per-model row and an account-wide row for the same strategyName
 *     coexist.
 *
 * Runs against the e2e Postgres (connections_test) with migrations applied.
 */
describe("RateLimitHold uniqueness (e2e)", () => {
  const row = (strategyName: string, modelName: string | null, reason: string | null = null) => ({
    strategyName,
    modelName,
    reason,
    heldAt: new Date(),
    resetAt: new Date(Date.now() + 3_600_000),
  });

  const insert = (r: ReturnType<typeof row>) =>
    AppDataSource.query(
      `INSERT INTO "RateLimitHold" ("strategyName", "modelName", "reason", "heldAt", "resetAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [r.strategyName, r.modelName, r.reason, r.heldAt, r.resetAt],
    );

  beforeAll(async () => {
    await AppDataSource.initialize();
    await AppDataSource.runMigrations();
  }, 60_000);

  afterEach(async () => {
    await AppDataSource.query(`DELETE FROM "RateLimitHold" WHERE "strategyName" LIKE 'e2e-%'`);
  });

  afterAll(async () => {
    await AppDataSource.destroy();
  });

  it("created both the composite unique and the partial account-wide unique index", async () => {
    const indexes: Array<{ indexname: string }> = await AppDataSource.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'RateLimitHold'`,
    );
    const names = indexes.map((i) => i.indexname);
    expect(names).toEqual(expect.arrayContaining([
      "UQ_RateLimitHold_strategy_model",
      "UQ_RateLimitHold_strategy_account",
    ]));
  });

  it("rejects a second account-wide row for the same strategyName", async () => {
    await insert(row("e2e-acct", null, "daily"));
    await expect(insert(row("e2e-acct", null, "per-minute-cooldown"))).rejects.toThrow();
  });

  it("rejects a duplicate per-model row for the same (strategyName, modelName)", async () => {
    await insert(row("e2e-model", "m1"));
    await expect(insert(row("e2e-model", "m1"))).rejects.toThrow();
  });

  it("lets a per-model row and an account-wide row coexist for one strategyName", async () => {
    await insert(row("e2e-mix", "m1"));
    await insert(row("e2e-mix", "m2"));
    await insert(row("e2e-mix", null, "daily"));

    const [{ count }]: Array<{ count: string }> = await AppDataSource.query(
      `SELECT COUNT(*)::int AS count FROM "RateLimitHold" WHERE "strategyName" = 'e2e-mix'`,
    );
    expect(count).toBe(3);
  });
});
