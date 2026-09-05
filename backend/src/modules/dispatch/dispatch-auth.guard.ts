import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppEnv } from "../../config/env";
import {
  ADMIN_REQUEST_HEADER,
  ADMIN_SESSION_COOKIE,
  parseCookieHeader,
  passwordsMatch,
  sessionSecret,
  verifySession,
} from "../auth/session";

/**
 * Guards dispatch routes that queue paid LLM provider calls or delete data,
 * behind either a valid admin session cookie (see session.ts) or a
 * `password` field in the request body matching DISPATCH_PASSWORD. Only
 * enforced when NODE_ENV=production (same signal PuzzleQueueBootstrap uses)
 * so local/dev/test dispatches stay unauthenticated. loadEnv() already
 * refuses to boot a production process without DISPATCH_PASSWORD set, so
 * reaching this guard in production with no configured password can only
 * mean misconfiguration — fail closed rather than let the request through.
 *
 * The cookie path also requires the X-Admin-Request header (defense in
 * depth alongside the cookie's own SameSite=Strict); the body.password
 * fallback path does not, so scripted/curl requests keep working exactly as
 * before.
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

    if (!expected) {
      throw new ForbiddenException("Invalid or missing dispatch password.");
    }

    const cookieValue = parseCookieHeader(request.headers?.cookie, ADMIN_SESSION_COOKIE);
    if (cookieValue && verifySession(cookieValue, sessionSecret(expected))) {
      if (request.headers?.[ADMIN_REQUEST_HEADER] !== "1") {
        throw new ForbiddenException("Missing X-Admin-Request header.");
      }
      return true;
    }

    const provided: unknown = request.body?.password;
    if (typeof provided === "string" && passwordsMatch(provided, expected)) {
      return true;
    }

    throw new ForbiddenException("Invalid or missing dispatch password.");
  }
}
