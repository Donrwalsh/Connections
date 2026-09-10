import { Module } from "@nestjs/common";

import { FreeDispatchModule } from "../provider-pool/free-dispatch.module";
import { GroqFreeDispatchService } from "./groq-free-dispatch.service";

@Module({
  imports: [FreeDispatchModule],
  providers: [GroqFreeDispatchService],
  exports: [GroqFreeDispatchService],
})
export class GroqFreeDispatchModule {}
