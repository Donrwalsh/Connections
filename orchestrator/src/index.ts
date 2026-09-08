import { serve } from "@hono/node-server";
import { app } from "./app.js";

const PORT = Number(process.env.PORT ?? 3001);

// Node's http.Server.requestTimeout defaults to 300000ms (5 min) and covers
// the whole request lifetime, including a slow handler — so a solve-assist
// call to a slow local model gets its socket destroyed mid-generation and
// the backend sees "fetch failed (UND_ERR_SOCKET: other side closed)". Raise
// it past the backend's own ORCHESTRATOR_TIMEOUT_MS so the backend's abort is
// what ends a too-long call, not this. 0 disables it entirely.
const REQUEST_TIMEOUT_MS = Number(process.env.ORCHESTRATOR_REQUEST_TIMEOUT_MS ?? 600000);

serve(
  { fetch: app.fetch, port: PORT, serverOptions: { requestTimeout: REQUEST_TIMEOUT_MS } },
  (info) => {
    console.log(`Orchestrator listening on http://localhost:${info.port}`);
  },
);
