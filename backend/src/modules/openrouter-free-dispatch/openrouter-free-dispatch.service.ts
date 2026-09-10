import { Inject, Injectable } from "@nestjs/common";

import { FreeDispatchService } from "../provider-pool/free-dispatch.service";

/**
 * Thin shim over the unified {@link FreeDispatchService}, bound to the
 * "openrouter" provider pool. Kept only so the dispatch controller and daily
 * automation keep resolving `OpenRouterFreeDispatchService` unchanged; it is
 * deleted when doc 10 collapses the per-provider dispatch routes into one
 * `/dispatch/pool/:poolId` pair.
 */
@Injectable()
export class OpenRouterFreeDispatchService {
  constructor(
    @Inject(FreeDispatchService) private readonly dispatch: FreeDispatchService,
  ) {}

  start() {
    return this.dispatch.start("openrouter");
  }

  stop() {
    return this.dispatch.stop("openrouter");
  }

  getStatus() {
    return this.dispatch.getStatus("openrouter");
  }

  runTick() {
    return this.dispatch.runTick("openrouter");
  }
}
