import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { SolveRequestSchema, type SolveResponse } from "./types.js";
import { proposeGroup } from "./solver.js";

const app = new Hono();

const PORT = Number(process.env.PORT ?? 3001);

// Simple shared-secret check so only the backend container can call this
// service. Not full auth — this is an internal-only service, not
// public-facing. Backend must send this header on every request.
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;

app.use("*", async (c, next) => {
  if (!INTERNAL_API_KEY) {
    // Fail loudly in any environment where the key isn't configured,
    // rather than silently running unauthenticated.
    return c.json(
      { error: "Server misconfigured: INTERNAL_API_KEY not set" },
      500,
    );
  }
  const provided = c.req.header("x-internal-api-key");
  if (provided !== INTERNAL_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.post("/solve", async (c) => {
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
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Orchestrator listening on http://localhost:${info.port}`);
});
