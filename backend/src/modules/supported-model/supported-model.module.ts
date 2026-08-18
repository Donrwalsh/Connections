import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { SupportedModel } from "./entities/supported-model.entity";
import { ModelPrice } from "./entities/model-price.entity";
import { SupportedModelService } from "./supported-model.service";

// Standalone module (not nested under game/ or strategy/) so both GameModule
// (puzzle-ingestion's automatic dispatch) and StrategyModule (the explicit
// /dispatch/strategy dispatch) can depend on it without creating a cycle
// between each other.
@Module({
  imports: [TypeOrmModule.forFeature([SupportedModel, ModelPrice])],
  providers: [SupportedModelService],
  exports: [SupportedModelService],
})
export class SupportedModelModule {}
