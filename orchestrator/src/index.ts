import { serve } from "@hono/node-server";
import { Agent, setGlobalDispatcher } from "undici";
import { app } from "./app.js";

const PORT = Number(process.env.PORT ?? 3001);

// Node's http.Server.requestTimeout defaults to 300000ms (5 min) and covers
// the whole request lifetime, including a slow handler — so a solve-assist
// call to a slow local model gets its socket destroyed mid-generation and
// the backend sees "fetch failed (UND_ERR_SOCKET: other side closed)". Raise
// it past the backend's own ORCHESTRATOR_TIMEOUT_MS so the backend's abort is
// what ends a too-long call, not this. 0 disables it entirely.
const REQUEST_TIMEOUT_MS = Number(process.env.ORCHESTRATOR_REQUEST_TIMEOUT_MS ?? 600000);

// undici (Node's fetch engine) also bounds every *outbound* call — here, the
// AI SDK's HTTP calls from the orchestrator to the model providers (Mistral,
// OpenAI, …) — with its own headersTimeout and bodyTimeout, both defaulting
// to 300s. A provider that holds the response open past 5 minutes (reasoning
// models, free-tier queueing) therefore fails as
// "Model call failed: Cannot connect to API: Headers Timeout Error" long
// before the backend's ORCHESTRATOR_TIMEOUT_MS deadline. Raise both past
// REQUEST_TIMEOUT_MS via the global dispatcher so the backend's
// AbortController stays the only real deadline for a too-long model call.
// Interim fix; streaming the provider response is the real solution.
setGlobalDispatcher(
  new Agent({
    headersTimeout: REQUEST_TIMEOUT_MS + 30_000,
    bodyTimeout: REQUEST_TIMEOUT_MS + 30_000,
  }),
);

serve(
  { fetch: app.fetch, port: PORT, serverOptions: { requestTimeout: REQUEST_TIMEOUT_MS } },
  (info) => {
    console.log(`Orchestrator listening on http://localhost:${info.port}`);
  },
);
