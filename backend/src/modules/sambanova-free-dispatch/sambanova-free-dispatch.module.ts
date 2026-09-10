import { Module } from "@nestjs/common";

import { FreeDispatchModule } from "../provider-pool/free-dispatch.module";
import { SambaNovaFreeDispatchService } from "./sambanova-free-dispatch.service";

@Module({
  imports: [FreeDispatchModule],
  providers: [SambaNovaFreeDispatchService],
  exports: [SambaNovaFreeDispatchService],
})
export class SambaNovaFreeDispatchModule {}
