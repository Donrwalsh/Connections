import { Inject, Injectable } from "@nestjs/common";

import { FreeDispatchService } from "../provider-pool/free-dispatch.service";

/**
 * Thin shim over the unified {@link FreeDispatchService}, bound to the
 * "google" provider pool. Kept only so the dispatch controller and daily
 * automation keep resolving `GoogleFreeDispatchService` unchanged; it is
 * deleted when doc 10 collapses the per-provider dispatch routes into one
 * `/dispatch/pool/:poolId` pair.
 */
@Injectable()
export class GoogleFreeDispatchService {
  constructor(
    @Inject(FreeDispatchService) private readonly dispatch: FreeDispatchService,
  ) {}

  start() {
    return this.dispatch.start("google");
  }

  stop() {
    return this.dispatch.stop("google");
  }

  getStatus() {
    return this.dispatch.getStatus("google");
  }

  runTick() {
    return this.dispatch.runTick("google");
  }
}
