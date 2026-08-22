import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import { loadEnv } from "./config/env";

async function bootstrap() {
  const env = loadEnv();
  const logger = new Logger("Bootstrap");

  const app = await NestFactory.create(AppModule);
  await configureApp(app);

  await app.listen(env.PORT, "0.0.0.0");
  logger.log(`NestJS backend running on http://localhost:${env.PORT}`);
  logger.log(`Swagger docs available at http://localhost:${env.PORT}/api/docs`);
  logger.log(`Bull Board available at http://localhost:${env.PORT}/bull/login`);
}

bootstrap();
