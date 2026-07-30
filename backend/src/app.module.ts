import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { ConfigModule } from "@nestjs/config";
import { GameModule } from "./modules/game/game.module";

@Module({
  imports: [
    // Global configurations (optional but recommended)
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    // Feature Modules
    GameModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
