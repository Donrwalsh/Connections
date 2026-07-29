import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();

  // Increase server timeout (in milliseconds)
  const httpAdapterHost = app.get(HttpAdapterHost);
  const server = httpAdapterHost.httpAdapter.getHttpServer();
  server.setTimeout(120000); // 120 seconds

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
}

bootstrap();
