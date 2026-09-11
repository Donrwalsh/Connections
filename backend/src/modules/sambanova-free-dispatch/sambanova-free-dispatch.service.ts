import { Inject, Injectable } from "@nestjs/common";

import { FreeDispatchService } from "../provider-pool/free-dispatch.service";

/**
 * Thin shim over the unified {@link FreeDispatchService}, bound to the
 * "sambanova" provider pool. Kept only so the dispatch controller and daily
 * automation keep resolving `SambaNovaFreeDispatchService` unchanged; it is
 * deleted when doc 10 collapses the per-provider dispatch routes into one
 * `/dispatch/pool/:poolId` pair.
 */
@Injectable()
export class SambaNovaFreeDispatchService {
  constructor(
    @Inject(FreeDispatchService) private readonly dispatch: FreeDispatchService,
  ) {}

  start() {
    return this.dispatch.start("sambanova");
  }

  stop() {
    return this.dispatch.stop("sambanova");
  }

  getStatus() {
    return this.dispatch.getStatus("sambanova");
  }

  runTick() {
    return this.dispatch.runTick("sambanova");
  }
}
