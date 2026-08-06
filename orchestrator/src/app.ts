import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { SolveRequestSchema, type SolveResponse } from "./types.js";
import { proposeGroup } from "./solver.js";

export const app = new Hono();

// A puzzle word list is at most 16 words — a few KB at most. Cap the body so
// a garbage/oversized request can't tie up memory while we parse it.
export const SOLVE_BODY_LIMIT = 64 * 1024;

// Simple shared-secret check so only the backend container can call this
// service. Not full auth — this is an internal-only service, not
// public-facing. Backend must send this header on every request.
// Read lazily per request so tests can stub it per-test.
const internalApiKey = () => process.env.INTERNAL_API_KEY;

app.use("*", async (c, next) => {
  const key = internalApiKey();
  if (!key) {
    // Fail loudly in any environment where the key isn't configured,
    // rather than silently running unauthenticated.
    return c.json(
      { error: "Server misconfigured: INTERNAL_API_KEY not set" },
      500,
    );
  }
  const provided = c.req.header("x-internal-api-key");
  if (provided !== key) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.post(
  "/solve",
  bodyLimit({
    maxSize: SOLVE_BODY_LIMIT,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  }),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SolveRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400,
      );
    }

    try {
      const { proposedGroup, prompt } = await proposeGroup(parsed.data);
      const response: SolveResponse = { proposedGroup, prompt };
      return c.json(response, 200);
    } catch (err) {
      console.error("Solve failed:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: "Solve failed", details: message }, 502);
    }
  },
);
