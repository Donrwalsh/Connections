import { Inject, Injectable } from "@nestjs/common";

import { FreeDispatchService } from "../provider-pool/free-dispatch.service";

/**
 * Thin shim over the unified {@link FreeDispatchService}, bound to the
 * "mistral" provider pool. Kept only so the dispatch controller and daily
 * automation keep resolving `MistralFreeDispatchService` unchanged; it is
 * deleted when doc 10 collapses the per-provider dispatch routes into one
 * `/dispatch/pool/:poolId` pair.
 */
@Injectable()
export class MistralFreeDispatchService {
  constructor(
    @Inject(FreeDispatchService) private readonly dispatch: FreeDispatchService,
  ) {}

  start() {
    return this.dispatch.start("mistral");
  }

  stop() {
    return this.dispatch.stop("mistral");
  }

  getStatus() {
    return this.dispatch.getStatus("mistral");
  }

  runTick() {
    return this.dispatch.runTick("mistral");
  }
}
