import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { RequestHandler } from "express";
import { loadEnv } from "./config/env";
import { puzzleQueue } from "./modules/queue/puzzle.queue";
import { strategyQueue } from "./modules/queue/strategy.queue";

/**
 * Express middleware requiring HTTP Basic auth in front of Bull Board. Fail
 * closed: when credentials aren't configured, the admin UI stays unreachable
 * rather than being exposed without auth.
 */
function bullBoardAuth(user: string, pass: string): RequestHandler {
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

  return (req, res, next) => {
    if (user && pass && req.headers.authorization === expected) {
      return next();
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="Bull Board"');
    res.status(401).send("Unauthorized");
  };
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
  serverAdapter.setBasePath("/admin/queues");

  createBullBoard({
    queues: [new BullMQAdapter(strategyQueue), new BullMQAdapter(puzzleQueue)],
    serverAdapter,
  });

  app.use(
    "/admin/queues",
    bullBoardAuth(env.BULL_BOARD_USER, env.BULL_BOARD_PASS),
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
