import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "crypto";
import type { AppEnv } from "../../config/env";

/**
 * Guards dispatch routes that queue paid LLM provider calls behind a
 * `password` field in the request body, checked against DISPATCH_PASSWORD.
 * Only enforced when NODE_ENV=production (same signal PuzzleQueueBootstrap
 * uses) so local/dev/test dispatches stay password-free. loadEnv() already
 * refuses to boot a production process without DISPATCH_PASSWORD set, so
 * reaching this guard in production with no configured password can only
 * mean misconfiguration — fail closed rather than let the request through.
 */
@Injectable()
export class DispatchAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppEnv, true>) {}

  canActivate(context: ExecutionContext): boolean {
    if (process.env.NODE_ENV !== "production") {
      return true;
    }

    const expected = this.config.get("DISPATCH_PASSWORD", { infer: true });
    const request = context.switchToHttp().getRequest();
    const provided: unknown = request.body?.password;

    if (!expected || typeof provided !== "string" || !passwordsMatch(provided, expected)) {
      throw new ForbiddenException("Invalid or missing dispatch password.");
    }

    return true;
  }
}

function passwordsMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}
