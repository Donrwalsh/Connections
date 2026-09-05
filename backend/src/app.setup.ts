import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { urlencoded, type RequestHandler } from "express";
import { loadEnv } from "./config/env";
import { puzzleQueue } from "./modules/queue/puzzle.queue";
import {
  strategyQueue,
  llmOpenAIQueue,
  llmOllamaQueue,
  llmGoogleQueue,
} from "./modules/queue/strategy.queue";

const BULL_LOGIN_PATH = "/bull/login";
const BULL_BOARD_PATH = "/bull/queues";
const BULL_SESSION_COOKIE = "bull_session";
// 12 hours — long enough for a workday, short enough that a stale cookie
// doesn't stay valid indefinitely.
const BULL_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Derives the HMAC key for signing session cookies from the same two env
 * vars Bull Board's credentials already come from — no separate secret to
 * configure. Changing BULL_BOARD_USER/PASS invalidates every outstanding
 * session, which is the desired behavior (equivalent to a password change).
 */
function bullSessionSecret(user: string, pass: string): Buffer {
  return createHash("sha256").update(`${user}:${pass}`).digest();
}

function signBullSession(secret: Buffer): string {
  const expiresAt = Date.now() + BULL_SESSION_MAX_AGE_MS;
  const signature = createHmac("sha256", secret).update(String(expiresAt)).digest("hex");
  return `${expiresAt}.${signature}`;
}

/** Verifies a session cookie's signature and expiry. Timing-safe comparison
 * guards against leaking the valid signature one byte at a time. */
function verifyBullSession(cookieValue: string | undefined, secret: Buffer): boolean {
  if (!cookieValue) return false;
  const [expiresAtRaw, signature] = cookieValue.split(".");
  const expiresAt = Number(expiresAtRaw);
  if (!signature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  const expected = Buffer.from(
    createHmac("sha256", secret).update(expiresAtRaw).digest("hex"),
    "hex",
  );
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() === name) {
      return part.slice(separatorIndex + 1).trim();
    }
  }
  return undefined;
}

/** Plain HTML login form — `autocomplete="username"`/`"current-password"`
 * so password managers recognize and offer to fill it, unlike a native
 * Basic Auth popup. */
function bullLoginPage(errorMessage?: string): string {
  return `<!doctype html>
<html>
<head>
<title>Bull Board Login</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #14151a; color: #e6e6e6; }
  form { display: flex; flex-direction: column; gap: 0.75rem; width: 280px; padding: 2rem; background: #1e1f27; border-radius: 8px; }
  input { padding: 0.5rem; border-radius: 4px; border: 1px solid #3a3b46; background: #14151a; color: #e6e6e6; font-size: 1rem; }
  button { padding: 0.5rem; border-radius: 4px; border: none; background: #4f7cff; color: white; font-size: 1rem; cursor: pointer; }
  .error { color: #ff6b6b; margin: 0; }
  h1 { font-size: 1.1rem; margin: 0 0 0.5rem; }
</style>
</head>
<body>
  <form method="post" action="${BULL_LOGIN_PATH}">
    <h1>Bull Board</h1>
    ${errorMessage ? `<p class="error">${errorMessage}</p>` : ""}
    <input type="text" name="username" placeholder="Username" autocomplete="username" required autofocus />
    <input type="password" name="password" placeholder="Password" autocomplete="current-password" required />
    <button type="submit">Log in</button>
  </form>
</body>
</html>`;
}

/**
 * Express middleware gating Bull Board on a signed session cookie instead
 * of HTTP Basic auth — a real login page (see mountBullLogin) rather than
 * the browser's native credential popup, which password managers often
 * can't autofill correctly. Fail closed: when credentials aren't
 * configured, no session can ever verify, so the board stays unreachable.
 */
function bullBoardGuard(user: string, pass: string): RequestHandler {
  const secret = bullSessionSecret(user, pass);

  return (req, res, next) => {
    const cookie = parseCookie(req.headers.cookie, BULL_SESSION_COOKIE);
    if (user && pass && verifyBullSession(cookie, secret)) {
      return next();
    }
    res.redirect(302, BULL_LOGIN_PATH);
  };
}

/** Registers the login form (GET) and its handler (POST), plus logout, on
 * their own unguarded paths — separate from BULL_BOARD_PATH so they never
 * need to pass through bullBoardGuard themselves. */
function mountBullLogin(app: INestApplication, user: string, pass: string): void {
  const secret = bullSessionSecret(user, pass);

  const loginHandler: RequestHandler = (req, res, next) => {
    if (req.method === "GET") {
      res.status(200).type("html").send(bullLoginPage());
      return;
    }

    if (req.method === "POST") {
      const body = req.body as { username?: string; password?: string } | undefined;
      const submittedUser = body?.username ?? "";
      const submittedPass = body?.password ?? "";

      if (user && pass && submittedUser === user && submittedPass === pass) {
        res.cookie(BULL_SESSION_COOKIE, signBullSession(secret), {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          maxAge: BULL_SESSION_MAX_AGE_MS,
        });
        res.redirect(302, BULL_BOARD_PATH);
        return;
      }

      res.status(401).type("html").send(bullLoginPage("Invalid username or password."));
      return;
    }

    next();
  };
  // Nest's default body parser isn't guaranteed to have run yet for
  // middleware registered this way (ahead of app.listen()'s own init), so
  // this route parses its own form body rather than relying on it.
  app.use(BULL_LOGIN_PATH, urlencoded({ extended: false }), loginHandler);

  const logoutHandler: RequestHandler = (_req, res) => {
    res.clearCookie(BULL_SESSION_COOKIE);
    res.redirect(302, BULL_LOGIN_PATH);
  };
  app.use("/bull/logout", logoutHandler);
}

/**
 * Applies the shared HTTP pipeline (CORS, validation, graceful shutdown,
 * Bull Board, Swagger). Kept separate from main.ts so E2E tests exercise the
 * exact same configuration as the running server.
 */
export async function configureApp(app: INestApplication): Promise<INestApplication> {
  const env = loadEnv();

  app.enableCors({
    origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableShutdownHooks();

  // The socket timeout must stay above the longest backend→orchestrator solve
  // chain (one full ORCHESTRATOR_TIMEOUT_MS step plus transport-retry slack),
  // or the server would kill a request the fetch layer would still be handling.
  const httpAdapterHost = app.get(HttpAdapterHost);
  const server = httpAdapterHost.httpAdapter.getHttpServer();
  server.setTimeout(env.ORCHESTRATOR_TIMEOUT_MS * 2 + 60000);

  // Bull Board
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);

  createBullBoard({
    queues: [
      new BullMQAdapter(strategyQueue),
      new BullMQAdapter(llmOpenAIQueue),
      new BullMQAdapter(llmOllamaQueue),
      new BullMQAdapter(llmGoogleQueue),
      new BullMQAdapter(puzzleQueue),
    ],
    serverAdapter,
  });

  mountBullLogin(app, env.BULL_BOARD_USER, env.BULL_BOARD_PASS);

  app.use(
    BULL_BOARD_PATH,
    bullBoardGuard(env.BULL_BOARD_USER, env.BULL_BOARD_PASS),
    serverAdapter.getRouter(),
  );

  // Swagger config
  const config = new DocumentBuilder()
    .setTitle("Connections API")
    .setDescription("API documentation for the Connections backend")
    .setVersion("1.0")
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, document);

  return app;
}
