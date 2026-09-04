import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { StrategyModule } from "../strategy/strategy.module";
import { FreeTierDispatchModule } from "../free-tier-dispatch/free-tier-dispatch.module";
import { GoogleFreeDispatchModule } from "../google-free-dispatch/google-free-dispatch.module";
import { QueueModule } from "../queue/queue.module";
import { AutomationRunLog } from "./entities/automation-run-log.entity";
import { DailyAutomationService } from "./daily-automation.service";
import { DailyAutomationBootstrap } from "./daily-automation.bootstrap";

@Module({
  imports: [
    TypeOrmModule.forFeature([AutomationRunLog]),
    StrategyModule,
    FreeTierDispatchModule,
    GoogleFreeDispatchModule,
    QueueModule,
  ],
  providers: [DailyAutomationService, DailyAutomationBootstrap],
  exports: [DailyAutomationService],
})
export class AutomationModule {}
