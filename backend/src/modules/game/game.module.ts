import { Module } from "@nestjs/common";
import { GameService } from "./game.service";
import { GameController } from "./game.controller";
import { Client } from "pg";
import { QueueModule } from "../queue/queue.module";

@Module({
  imports: [QueueModule],
  controllers: [GameController],
  providers: [
    {
      provide: "PG",
      useFactory: async () => {
        const client = new Client({
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT),
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
        });

        await client.connect();
        console.log("Connected to Postgres");
        return client;
      },
    },
    GameService,
  ],
  exports: [GameService],
})
export class GameModule {}
