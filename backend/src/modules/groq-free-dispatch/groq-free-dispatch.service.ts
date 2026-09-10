import { Inject, Injectable } from "@nestjs/common";

import { FreeDispatchService } from "../provider-pool/free-dispatch.service";

/**
 * Thin shim over the unified {@link FreeDispatchService}, bound to the
 * "groq" provider pool. Kept only so the dispatch controller and daily
 * automation keep resolving `GroqFreeDispatchService` unchanged; it is
 * deleted when doc 10 collapses the per-provider dispatch routes into one
 * `/dispatch/pool/:poolId` pair.
 */
@Injectable()
export class GroqFreeDispatchService {
  constructor(
    @Inject(FreeDispatchService) private readonly dispatch: FreeDispatchService,
  ) {}

  start() {
    return this.dispatch.start("groq");
  }

  stop() {
    return this.dispatch.stop("groq");
  }

  getStatus() {
    return this.dispatch.getStatus("groq");
  }

  runTick() {
    return this.dispatch.runTick("groq");
  }
}
