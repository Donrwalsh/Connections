import { Inject, Injectable } from "@nestjs/common";
import { Client } from "pg";

@Injectable()
export class AppService {
  constructor(@Inject("PG") private readonly db: Client) {}

  getHello() {
    return { message: "Hello from NestJS starter app!" };
  }

  async getLatestDate() {
    const result = await this.db.query(
      "SELECT MAX(date) AS latest_date FROM Puzzle",
    );
    return result.rows[0].latest_date;
  }
}
