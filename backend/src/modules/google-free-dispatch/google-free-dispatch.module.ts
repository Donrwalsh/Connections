import { Module } from "@nestjs/common";

import { FreeDispatchModule } from "../provider-pool/free-dispatch.module";
import { GoogleFreeDispatchService } from "./google-free-dispatch.service";

@Module({
  imports: [FreeDispatchModule],
  providers: [GoogleFreeDispatchService],
  exports: [GoogleFreeDispatchService],
})
export class GoogleFreeDispatchModule {}
