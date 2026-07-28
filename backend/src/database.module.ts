import { Module } from "@nestjs/common";
import { Client } from "pg";

@Module({
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
  ],
  exports: ["PG"],
})
export class DatabaseModule {}
