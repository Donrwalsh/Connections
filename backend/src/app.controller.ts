import { Body, Controller, Get, Post } from "@nestjs/common";
import { AppService } from "./app.service";
// import { IsString } from 'class-validator';

export interface PriorGuessDto {
  words: string[];
  result: "correct" | "incorrect" | "oneAway";
}

export class SolveDto {
  // @IsArray()
  // @IsString({ each: true })
  puzzleWords!: string[];
  // @IsArray()
  // @IsOptional()
  priorGuesses?: PriorGuessDto[];
}

export interface ProposedGroupDto {
  words: string[];
  category: string;
  confidence: number;
  reasoning: string;
}

// Mirrors the orchestrator's SolveResponseSchema (orchestrator/src/types.ts).
// `prompt` is the exact text sent to the model — forwarded through so the
// frontend can display it alongside the recommendation.
export interface SolveResponseDto {
  proposedGroup: ProposedGroupDto;
  prompt: string;
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
    return this.appService.solve(body.puzzleWords, body.priorGuesses ?? []);
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
