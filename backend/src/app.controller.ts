import { Controller, Get } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("api/hello")
  getHello() {
    return this.appService.getHello();
  }

  @Get("api/latest_date")
  getLatestDate() {
    return this.appService.getLatestDate();
  }
}
