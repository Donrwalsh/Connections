import { Module } from "@nestjs/common";

import { FreeDispatchModule } from "../provider-pool/free-dispatch.module";
import { OpenRouterFreeDispatchService } from "./openrouter-free-dispatch.service";

@Module({
  imports: [FreeDispatchModule],
  providers: [OpenRouterFreeDispatchService],
  exports: [OpenRouterFreeDispatchService],
})
export class OpenRouterFreeDispatchModule {}
