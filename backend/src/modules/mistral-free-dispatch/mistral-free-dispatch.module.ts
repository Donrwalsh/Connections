import { Module } from "@nestjs/common";

import { FreeDispatchModule } from "../provider-pool/free-dispatch.module";
import { MistralFreeDispatchService } from "./mistral-free-dispatch.service";

@Module({
  imports: [FreeDispatchModule],
  providers: [MistralFreeDispatchService],
  exports: [MistralFreeDispatchService],
})
export class MistralFreeDispatchModule {}
