import { Body, Controller, Get, Post } from "@nestjs/common";
import { AppService } from "./app.service";
// import { IsString } from 'class-validator';

export class SolveDto {
  // @IsArray()
  // @IsString({ each: true })
  puzzleWords!: string[];
}

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("api/hello")
  getHello() {
    return this.appService.getHello();
  }

  @Get("puzzle/today")
  getTodaysPuzzle() {
    return this.appService.getTodaysPuzzle();
  }

  @Get("api/latest_date")
  getLatestDate() {
    return this.appService.getLatestDate();
  }

  @Get("api/orchestrator/health")
  getOrchestratorHealth() {
    return this.appService.checkOrchestrator();
  }

  @Post("api/solve")
  async solve(@Body() body: SolveDto) {
    return this.appService.solve(body.puzzleWords);
  }
}

// {
//   "puzzleWords": [
//     "outfield",
//     "fore",
//     "shortstop",
//     "ate",
//     "fusilli",
//     "penne",
//     "pitcher",
//     "too",
//     "bar",
//     "morse",
//     "farfalle",
//     "won",
//     "zip",
//     "dress",
//     "catcher",
//     "rotini"
//   ]
// }
