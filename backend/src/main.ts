import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { puzzleQueue } from "./modules/queue/puzzle.queue";
import { strategyQueue } from "./modules/queue/strategy.queue";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();

  // Increase server timeout (in milliseconds)
  const httpAdapterHost = app.get(HttpAdapterHost);
  const server = httpAdapterHost.httpAdapter.getHttpServer();
  server.setTimeout(120000); // 120 seconds

  // Bull Board
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");

  createBullBoard({
    queues: [new BullMQAdapter(strategyQueue), new BullMQAdapter(puzzleQueue)],
    serverAdapter,
  });

  app.use("/admin/queues", serverAdapter.getRouter());

  // Swagger config
  const config = new DocumentBuilder()
    .setTitle("Connections API")
    .setDescription("API documentation for the Connections backend")
    .setVersion("1.0")
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, document);

  await app.listen(4000, "0.0.0.0");
  console.log("NestJS backend running on http://localhost:4000");
  console.log("Swagger docs available at http://localhost:4000/api/docs");
  console.log("Bull Board available at http://localhost:4000/admin/queues");
}

bootstrap();
