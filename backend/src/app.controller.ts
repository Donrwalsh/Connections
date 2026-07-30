import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { AppService } from "./app.service";
import { SolveDto } from "./modules/game/dto/game.dto";

@Controller()
export class AppController {
  constructor(@Inject(AppService) private readonly appService: AppService) {}

  @Get("api/orchestrator/health")
  getOrchestratorHealth() {
    return this.appService.checkOrchestrator();
  }

  @Post("api/solve")
  async solve(@Body() body: SolveDto) {
    return this.appService.solve(body.puzzleWords, body.priorGuesses ?? []);
  }
}
