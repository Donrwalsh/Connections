import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  AssistRequestSchema,
  JudgeCategoryRequestSchema,
  SolveAssistRequestSchema,
  type JudgeCategoryResponse,
  type SolveAssistResponse,
} from "./types.js";
import { SolveError } from "./solver.js";
import { runAssistStep } from "./assist.js";
import { solveAssist } from "./solve-assist.js";
import { judgeCategory } from "./judge-category.js";

export const app = new Hono();

// A puzzle word list is at most 16 words — a few KB at most. Cap the body so
// a garbage/oversized request can't tie up memory while we parse it.
export const SOLVE_BODY_LIMIT = 64 * 1024;

const ERROR_STATUS: Record<SolveError["code"], 409 | 400 | 502> = {
  duplicate_group: 409,
  invalid_group: 400,
  model_error: 502,
};

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
  "/diagnose",
  bodyLimit({
    maxSize: SOLVE_BODY_LIMIT,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  }),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = AssistRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400,
      );
    }

    try {
      // Conversational AI Assist: the frontend owns the session (prompt
      // building, history, guess submission) and sends the full message
      // history here. Nothing is persisted by this service.
      const assistResult = await runAssistStep(parsed.data.messages);
      return c.json(assistResult, 200);
    } catch (err) {
      console.error("Diagnose failed:", err);
      if (err instanceof SolveError) {
        return c.json(
          {
            error: err.message,
            code: err.code,
            details: err.details,
          },
          ERROR_STATUS[err.code],
        );
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: "Diagnose failed", details: message }, 502);
    }
  },
);

app.post(
  "/solve-assist",
  bodyLimit({
    maxSize: SOLVE_BODY_LIMIT,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  }),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SolveAssistRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400,
      );
    }

    try {
      const result = await solveAssist(
        parsed.data.messages,
        parsed.data.model,
        parsed.data.provider,
        parsed.data.contextWindow,
        c.req.raw.signal,
      );
      const response: SolveAssistResponse = result;
      return c.json(response, 200);
    } catch (err) {
      console.error("Solve-assist failed:", err);
      if (err instanceof SolveError) {
        return c.json(
          {
            error: err.message,
            code: err.code,
            details: err.details,
          },
          ERROR_STATUS[err.code],
        );
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: "Solve-assist failed", details: message }, 502);
    }
  },
);

app.post(
  "/judge-category",
  bodyLimit({
    maxSize: SOLVE_BODY_LIMIT,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  }),
  async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = JudgeCategoryRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        400,
      );
    }

    try {
      const result = await judgeCategory(
        parsed.data.proposedCategory,
        parsed.data.actualCategory,
        parsed.data.model,
        parsed.data.provider,
        c.req.raw.signal,
      );
      const response: JudgeCategoryResponse = result;
      return c.json(response, 200);
    } catch (err) {
      console.error("Judge-category failed:", err);
      if (err instanceof SolveError) {
        return c.json(
          { error: err.message, code: err.code, details: err.details },
          ERROR_STATUS[err.code],
        );
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return c.json({ error: "Judge-category failed", details: message }, 502);
    }
  },
);
