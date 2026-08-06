import { Body, Controller, Get, Inject, Post, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { AppService } from "./app.service";
import { SolveDto } from "./modules/game/dto/game.dto";

@Controller()
export class AppController {
  constructor(@Inject(AppService) private readonly appService: AppService) {}

  @Get("health")
  async getHealth(@Res({ passthrough: true }) res: Response) {
    const health = await this.appService.checkHealth();
    if (health.status !== "ok") {
      res.status(503);
    }
    return health;
  }

  // /api/solve costs OpenAI tokens on every call, so it gets a much tighter
  // per-IP budget than the global default.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post("api/solve")
  async solve(@Body() body: SolveDto) {
    return this.appService.solve(body.puzzleWords, body.priorGuesses ?? []);
  }
}
