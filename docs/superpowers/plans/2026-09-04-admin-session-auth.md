# Admin Session Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-request `DISPATCH_PASSWORD` field on every admin action with a 90-day signed session cookie set from a hidden `/admin-login` page, and hide every admin-only control/page from non-admin visitors instead of just password-gating the action behind it.

**Architecture:** A signed, `httpOnly`, `SameSite=Strict` cookie (`admin_session`), following the existing Bull Board login pattern in `app.setup.ts` (HMAC-over-expiry, secret derived from `DISPATCH_PASSWORD`, no session store). `DispatchAuthGuard` accepts either a valid cookie (plus a static `X-Admin-Request` CSRF header) or the existing `body.password` fallback, so curl/script access keeps working unchanged. A new `GET /auth/me` endpoint tells the frontend whether the current browser holds a valid session; a React context (`AdminAuthContext`) fetches it once and every admin-only control in the UI renders conditionally on `isAdmin`.

**Tech Stack:** NestJS + `@nestjs/config` (backend), `crypto` (HMAC signing, already used by `app.setup.ts`'s Bull Board login), React + React Router + TanStack Query (frontend), Jest (backend tests), Vitest + Testing Library (frontend tests).

**Spec:** `docs/superpowers/specs/2026-09-04-admin-session-auth-design.md`

## Global Constraints

- **Explicit DI:** every class-to-class constructor injection in the backend uses an explicit `@Inject(Token)` — bare typed parameters silently resolve to `undefined` under the worker's tsx/esbuild runtime.
- **Session cookie:** name `admin_session`, `httpOnly`, `secure` only when `NODE_ENV=production`, `SameSite=Strict`, 90-day `maxAge` (`90 * 24 * 60 * 60 * 1000` ms).
- **CSRF header:** `X-Admin-Request: 1`, required only on the cookie-authenticated path, never on the `body.password` fallback path.
- **No new env vars:** the session secret is derived from the existing `DISPATCH_PASSWORD`.
- **Dev/test bypass unchanged:** `DispatchAuthGuard` and `GET /auth/me` both auto-pass/report-admin whenever `NODE_ENV !== "production"`, matching today's guard behavior exactly.
- **TDD:** write the failing test, watch it fail, minimal implementation, watch it pass, commit. Backend test command: `cd backend && npm test -- <path>`. Frontend: `cd frontend && npm test -- <path>`.
- **Commit style:** Conventional Commits (`feat:`, `test:`, `refactor:`, `docs:`). Commit at each step-5.

---

## File Structure

**Backend — created**
- `backend/src/modules/auth/session.ts` — `sessionSecret`, `signSession`, `verifySession`, `parseCookieHeader`, `passwordsMatch`, and the `ADMIN_SESSION_COOKIE` / `ADMIN_SESSION_MAX_AGE_MS` / `ADMIN_REQUEST_HEADER` constants. Shared by the guard and the new controller.
- `backend/src/modules/auth/session.spec.ts` — its tests.
- `backend/src/modules/auth/dto/login.dto.ts` — `LoginDto`.
- `backend/src/modules/auth/auth.controller.ts` — `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- `backend/src/modules/auth/auth.controller.spec.ts` — its tests.
- `backend/src/modules/auth/auth.module.ts` — registers `AuthController`.

**Backend — modified**
- `backend/src/modules/dispatch/dispatch-auth.guard.ts` — cookie-first, password-fallback-second; CSRF header check on the cookie path.
- `backend/src/modules/dispatch/dispatch-auth.guard.spec.ts` — new cookie/CSRF/expiry/tamper cases.
- `backend/src/app.module.ts` — import and register `AuthModule`.
- `backend/src/app.setup.ts` — `credentials: true` on `enableCors`, so the cross-origin `admin_session` cookie is actually sent/received in dev (frontend `:5173` → backend `:4000`).

**Frontend — created**
- `frontend/src/data/authApi.ts` — `fetchAuthMe`, `loginAdmin`, `logoutAdmin`.
- `frontend/src/auth/AdminAuthContext.tsx` — `AdminAuthContext`, `AdminAuthProvider`, `useAdminAuth`.
- `frontend/src/auth/__tests__/AdminAuthContext.test.tsx` — its tests.
- `frontend/src/pages/AdminLoginPage.tsx` — the hidden `/admin-login` form.
- `frontend/src/pages/__tests__/AdminLoginPage.test.tsx` — its tests.
- `frontend/src/pages/benchmark/__tests__/MaintenancePage.test.tsx` — admin/non-admin rendering tests (no prior dedicated test file existed).

**Frontend — modified**
- `frontend/src/data/benchmark/api.ts` — export `apiUrl`; add `ADMIN_SESSION_EXPIRED_EVENT` and `fetchJsonAdmin`; `deleteRun`, `deleteErroredRuns`, `deleteFailedJudgeCalls`, `startFreeTierDispatch`, `startBothFreeTierDispatch` drop their `password` parameter and switch to `fetchJsonAdmin`.
- `frontend/src/data/benchmark/api.test.ts` — updated assertions for the five functions above.
- `frontend/src/components/benchmark/DeleteRunModal.tsx` / `__tests__/DeleteRunModal.test.tsx` — drop the password field.
- `frontend/src/components/benchmark/FreeTierDispatchModal.tsx` — drop the password field.
- `frontend/src/components/benchmark/BulkActionModal.tsx` / `__tests__/BulkActionModal.test.tsx` — drop the password field; `action` becomes a zero-arg callback.
- `frontend/src/components/benchmark/MaintenancePanel.tsx` — pass `deleteErroredRuns`/`deleteFailedJudgeCalls` directly as `action`.
- `frontend/src/main.tsx` — mount `AdminAuthProvider`.
- `frontend/src/App.tsx` — add the lazy `/admin-login` route.
- `frontend/src/components/Header.tsx` / `__tests__/Header.test.tsx` — Maintenance nav link and a Log out control, both admin-only.
- `frontend/src/pages/benchmark/ActivityPage.tsx` / `__tests__/ActivityPage.test.tsx` — gate the operational widget row, the Enable Auto-Dispatch button, and their backing queries on `isAdmin`.
- `frontend/src/pages/benchmark/MaintenancePage.tsx` — gate its content on `isAdmin`, not-found otherwise.
- `frontend/src/components/benchmark/GuessChainVisualizer.tsx` / `__tests__/GuessChainVisualizer.test.tsx` — gate "Delete this run" on `isAdmin`.
- `frontend/src/__tests__/App.test.tsx` — wrap `renderApp` in `AdminAuthProvider`; update the `/activity` and `/maintenance` tests for admin gating; add non-admin cases for both.

---

## Task 1: Session helpers (`session.ts`)

**Files:**
- Create: `backend/src/modules/auth/session.ts`
- Test: `backend/src/modules/auth/session.spec.ts`

**Interfaces:**
- Produces: `ADMIN_SESSION_COOKIE: string`, `ADMIN_SESSION_MAX_AGE_MS: number`, `ADMIN_REQUEST_HEADER: string`, `sessionSecret(password: string): Buffer`, `signSession(secret: Buffer): string`, `verifySession(cookieValue: string | undefined, secret: Buffer): boolean`, `parseCookieHeader(header: string | undefined, name: string): string | undefined`, `passwordsMatch(provided: string, expected: string): boolean` — all consumed by Task 2 (`DispatchAuthGuard`) and Task 3 (`AuthController`).

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/modules/auth/session.spec.ts
import { createHmac } from "crypto";
import {
  ADMIN_SESSION_COOKIE,
  parseCookieHeader,
  passwordsMatch,
  sessionSecret,
  signSession,
  verifySession,
} from "./session";

describe("session", () => {
  describe("signSession / verifySession", () => {
    it("verifies a freshly signed token", () => {
      const secret = sessionSecret("secret");
      expect(verifySession(signSession(secret), secret)).toBe(true);
    });

    it("rejects a token signed with a different secret", () => {
      const token = signSession(sessionSecret("secret"));
      expect(verifySession(token, sessionSecret("other"))).toBe(false);
    });

    it("rejects an expired token", () => {
      const secret = sessionSecret("secret");
      const expiresAt = Date.now() - 1000;
      const signature = createHmac("sha256", secret).update(String(expiresAt)).digest("hex");
      expect(verifySession(`${expiresAt}.${signature}`, secret)).toBe(false);
    });

    it("rejects a tampered signature", () => {
      const secret = sessionSecret("secret");
      const token = signSession(secret);
      const [expiresAt] = token.split(".");
      expect(verifySession(`${expiresAt}.${"0".repeat(64)}`, secret)).toBe(false);
    });

    it("rejects undefined", () => {
      expect(verifySession(undefined, sessionSecret("secret"))).toBe(false);
    });
  });

  describe("parseCookieHeader", () => {
    it("extracts the named cookie from a multi-cookie header", () => {
      expect(parseCookieHeader("a=1; admin_session=abc; b=2", ADMIN_SESSION_COOKIE)).toBe("abc");
    });

    it("returns undefined when the cookie is missing", () => {
      expect(parseCookieHeader("a=1", ADMIN_SESSION_COOKIE)).toBeUndefined();
    });

    it("returns undefined for an undefined header", () => {
      expect(parseCookieHeader(undefined, ADMIN_SESSION_COOKIE)).toBeUndefined();
    });
  });

  describe("passwordsMatch", () => {
    it("matches equal strings", () => {
      expect(passwordsMatch("secret", "secret")).toBe(true);
    });

    it("rejects different strings", () => {
      expect(passwordsMatch("secret", "wrong")).toBe(false);
    });

    it("rejects different-length strings without throwing", () => {
      expect(passwordsMatch("s", "secret")).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npm test -- src/modules/auth/session.spec.ts`
Expected: FAIL — `Cannot find module './session'`

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/modules/auth/session.ts
import { createHash, createHmac, timingSafeEqual } from "crypto";

/**
 * Cookie carrying the signed admin session — see signSession/verifySession.
 * Shared by DispatchAuthGuard (checks it) and AuthController (sets/clears
 * it). Distinct from Bull Board's own `bull_session` cookie in app.setup.ts,
 * which uses the same HMAC-over-expiry scheme but a different secret.
 */
export const ADMIN_SESSION_COOKIE = "admin_session";

// 90 days — "log in once per device," per this feature's whole point.
export const ADMIN_SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Required (as a plain "1", not a secret) on any state-changing request
 * authenticating via the session cookie — defense-in-depth alongside the
 * cookie's own SameSite=Strict against cross-site requests. Not required on
 * the body.password fallback path (see DispatchAuthGuard). */
export const ADMIN_REQUEST_HEADER = "x-admin-request";

/** Derives the HMAC key for signing session cookies from DISPATCH_PASSWORD —
 * no separate secret to configure. Rotating DISPATCH_PASSWORD invalidates
 * every outstanding session, same as any other password change should. */
export function sessionSecret(password: string): Buffer {
  return createHash("sha256").update(`admin:${password}`).digest();
}

export function signSession(secret: Buffer): string {
  const expiresAt = Date.now() + ADMIN_SESSION_MAX_AGE_MS;
  const signature = createHmac("sha256", secret).update(String(expiresAt)).digest("hex");
  return `${expiresAt}.${signature}`;
}

/** Verifies a session cookie's signature and expiry. Timing-safe comparison
 * guards against leaking the valid signature one byte at a time. */
export function verifySession(cookieValue: string | undefined, secret: Buffer): boolean {
  if (!cookieValue) return false;
  const [expiresAtRaw, signature] = cookieValue.split(".");
  const expiresAt = Number(expiresAtRaw);
  if (!signature || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  const expected = Buffer.from(
    createHmac("sha256", secret).update(expiresAtRaw).digest("hex"),
    "hex",
  );
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseCookieHeader(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() === name) {
      return part.slice(separatorIndex + 1).trim();
    }
  }
  return undefined;
}

/** Timing-safe password comparison — shared by DispatchAuthGuard's
 * body.password fallback and AuthController's login check. */
export function passwordsMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npm test -- src/modules/auth/session.spec.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/auth/session.ts backend/src/modules/auth/session.spec.ts
git commit -m "$(cat <<'EOF'
feat(auth): add signed admin-session cookie helpers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `DispatchAuthGuard` accepts the session cookie

**Files:**
- Modify: `backend/src/modules/dispatch/dispatch-auth.guard.ts`
- Modify: `backend/src/modules/dispatch/dispatch-auth.guard.spec.ts`

**Interfaces:**
- Consumes: `ADMIN_SESSION_COOKIE`, `ADMIN_REQUEST_HEADER`, `parseCookieHeader`, `passwordsMatch`, `sessionSecret`, `verifySession` from `../auth/session` (Task 1).
- Produces: `DispatchAuthGuard` (unchanged public shape — `canActivate(context): boolean`) — every existing `@UseGuards(DispatchAuthGuard)` call site is untouched.

- [ ] **Step 1: Write the failing tests**

Replace `backend/src/modules/dispatch/dispatch-auth.guard.spec.ts` in full:

```typescript
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DispatchAuthGuard } from "./dispatch-auth.guard";
import { ADMIN_REQUEST_HEADER, ADMIN_SESSION_COOKIE, sessionSecret, signSession } from "../auth/session";

function makeContext(body: unknown, headers: Record<string, string> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ body, headers }),
    }),
  } as unknown as ExecutionContext;
}

describe("DispatchAuthGuard", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  function makeGuard(dispatchPassword: string) {
    const config = { get: () => dispatchPassword } as unknown as ConfigService;
    return new DispatchAuthGuard(config as never);
  }

  it("allows any request outside production", () => {
    process.env.NODE_ENV = "test";
    const guard = makeGuard("secret");

    expect(guard.canActivate(makeContext({}))).toBe(true);
    expect(guard.canActivate(makeContext({ password: "wrong" }))).toBe(true);
  });

  it("allows a request in production with the matching password", () => {
    process.env.NODE_ENV = "production";
    const guard = makeGuard("secret");

    expect(guard.canActivate(makeContext({ password: "secret" }))).toBe(true);
  });

  it("rejects a request in production with a wrong or missing password", () => {
    process.env.NODE_ENV = "production";
    const guard = makeGuard("secret");

    expect(() => guard.canActivate(makeContext({ password: "wrong" }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(makeContext({}))).toThrow(ForbiddenException);
  });

  it("fails closed in production if DISPATCH_PASSWORD isn't configured", () => {
    process.env.NODE_ENV = "production";
    const guard = makeGuard("");

    expect(() => guard.canActivate(makeContext({ password: "" }))).toThrow(ForbiddenException);
  });

  it("allows a request in production with a valid session cookie and the CSRF header", () => {
    process.env.NODE_ENV = "production";
    const guard = makeGuard("secret");
    const token = signSession(sessionSecret("secret"));

    expect(
      guard.canActivate(
        makeContext({}, { cookie: `${ADMIN_SESSION_COOKIE}=${token}`, [ADMIN_REQUEST_HEADER]: "1" }),
      ),
    ).toBe(true);
  });

  it("rejects a valid session cookie missing the CSRF header", () => {
    process.env.NODE_ENV = "production";
    const guard = makeGuard("secret");
    const token = signSession(sessionSecret("secret"));

    expect(() =>
      guard.canActivate(makeContext({}, { cookie: `${ADMIN_SESSION_COOKIE}=${token}` })),
    ).toThrow(ForbiddenException);
  });

  it("rejects an expired session cookie", () => {
    process.env.NODE_ENV = "production";
    const guard = makeGuard("secret");
    const expiredToken = `${Date.now() - 1000}.${"0".repeat(64)}`;

    expect(() =>
      guard.canActivate(
        makeContext(
          {},
          { cookie: `${ADMIN_SESSION_COOKIE}=${expiredToken}`, [ADMIN_REQUEST_HEADER]: "1" },
        ),
      ),
    ).toThrow(ForbiddenException);
  });

  it("rejects a tampered session cookie", () => {
    process.env.NODE_ENV = "production";
    const guard = makeGuard("secret");
    const token = signSession(sessionSecret("secret"));
    const [expiresAt] = token.split(".");
    const tampered = `${expiresAt}.${"0".repeat(64)}`;

    expect(() =>
      guard.canActivate(
        makeContext({}, { cookie: `${ADMIN_SESSION_COOKIE}=${tampered}`, [ADMIN_REQUEST_HEADER]: "1" }),
      ),
    ).toThrow(ForbiddenException);
  });

  it("falls back to the password check when the session cookie doesn't verify", () => {
    process.env.NODE_ENV = "production";
    const guard = makeGuard("secret");

    expect(
      guard.canActivate(makeContext({ password: "secret" }, { cookie: "admin_session=garbage" })),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd backend && npm test -- src/modules/dispatch/dispatch-auth.guard.spec.ts`
Expected: the 4 pre-existing tests PASS unchanged; the 5 new cookie/CSRF tests FAIL (guard has no cookie support yet)

- [ ] **Step 3: Write the implementation**

Replace `backend/src/modules/dispatch/dispatch-auth.guard.ts` in full:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npm test -- src/modules/dispatch/dispatch-auth.guard.spec.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/dispatch/dispatch-auth.guard.ts backend/src/modules/dispatch/dispatch-auth.guard.spec.ts
git commit -m "$(cat <<'EOF'
feat(dispatch): accept the admin session cookie in DispatchAuthGuard

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `AuthModule` (`/auth/login`, `/auth/logout`, `/auth/me`)

**Files:**
- Create: `backend/src/modules/auth/dto/login.dto.ts`
- Create: `backend/src/modules/auth/auth.controller.ts`
- Create: `backend/src/modules/auth/auth.controller.spec.ts`
- Create: `backend/src/modules/auth/auth.module.ts`
- Modify: `backend/src/app.module.ts`
- Modify: `backend/src/app.setup.ts`

**Interfaces:**
- Consumes: `ADMIN_SESSION_COOKIE`, `ADMIN_SESSION_MAX_AGE_MS`, `parseCookieHeader`, `passwordsMatch`, `sessionSecret`, `signSession`, `verifySession` from `./session` (Task 1).
- Produces: `POST /auth/login` (`{ password: string }` → `{ ok: true }` or 403), `POST /auth/logout` (→ `{ ok: true }`), `GET /auth/me` (→ `{ isAdmin: boolean }`) — consumed by Task 4's frontend `authApi.ts`.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/src/modules/auth/dto/login.dto.ts
import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class LoginDto {
  @ApiProperty({ type: String, description: "Must match the server's DISPATCH_PASSWORD." })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
```

```typescript
// backend/src/modules/auth/auth.controller.spec.ts
import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { AuthController } from "./auth.controller";
import { ADMIN_SESSION_COOKIE, sessionSecret, signSession } from "./session";

function makeResponse(): Response {
  return { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;
}

function makeRequest(cookieHeader?: string): Request {
  return { headers: { cookie: cookieHeader } } as unknown as Request;
}

describe("AuthController", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  function makeController(dispatchPassword: string) {
    const config = { get: () => dispatchPassword } as unknown as ConfigService;
    return new AuthController(config as never);
  }

  describe("login", () => {
    it("sets the session cookie and returns ok on the matching password", () => {
      const controller = makeController("secret");
      const res = makeResponse();

      const result = controller.login({ password: "secret" }, res);

      expect(result).toEqual({ ok: true });
      expect(res.cookie).toHaveBeenCalledWith(
        ADMIN_SESSION_COOKIE,
        expect.any(String),
        expect.objectContaining({ httpOnly: true, sameSite: "strict" }),
      );
    });

    it("rejects a wrong password without setting a cookie", () => {
      const controller = makeController("secret");
      const res = makeResponse();

      expect(() => controller.login({ password: "wrong" }, res)).toThrow(ForbiddenException);
      expect(res.cookie).not.toHaveBeenCalled();
    });
  });

  describe("logout", () => {
    it("clears the session cookie", () => {
      const controller = makeController("secret");
      const res = makeResponse();

      const result = controller.logout(res);

      expect(result).toEqual({ ok: true });
      expect(res.clearCookie).toHaveBeenCalledWith(ADMIN_SESSION_COOKIE);
    });
  });

  describe("me", () => {
    it("is always admin outside production", () => {
      process.env.NODE_ENV = "test";
      const controller = makeController("secret");

      expect(controller.me(makeRequest())).toEqual({ isAdmin: true });
    });

    it("is admin in production with a valid session cookie", () => {
      process.env.NODE_ENV = "production";
      const controller = makeController("secret");
      const token = signSession(sessionSecret("secret"));

      expect(controller.me(makeRequest(`${ADMIN_SESSION_COOKIE}=${token}`))).toEqual({
        isAdmin: true,
      });
    });

    it("is not admin in production without a valid session cookie", () => {
      process.env.NODE_ENV = "production";
      const controller = makeController("secret");

      expect(controller.me(makeRequest())).toEqual({ isAdmin: false });
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npm test -- src/modules/auth/auth.controller.spec.ts`
Expected: FAIL — `Cannot find module './auth.controller'`

- [ ] **Step 3: Write the implementation**

```typescript
// backend/src/modules/auth/auth.controller.ts
import { Body, Controller, ForbiddenException, Get, Inject, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import type { AppEnv } from "../../config/env";
import { LoginDto } from "./dto/login.dto";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_MS,
  parseCookieHeader,
  passwordsMatch,
  sessionSecret,
  signSession,
  verifySession,
} from "./session";

/**
 * The site's one admin identity, gated by DISPATCH_PASSWORD — see
 * session.ts for the signed-cookie scheme. login/logout/me are themselves
 * unguarded: login can't require the session it grants, and logout/me are
 * safe to call from any session, admin or not.
 */
@Controller("auth")
export class AuthController {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<AppEnv, true>) {}

  @Post("login")
  login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response): { ok: true } {
    const expected = this.config.get("DISPATCH_PASSWORD", { infer: true });
    if (!expected || !passwordsMatch(body.password, expected)) {
      throw new ForbiddenException("Incorrect password.");
    }

    res.cookie(ADMIN_SESSION_COOKIE, signSession(sessionSecret(expected)), {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      maxAge: ADMIN_SESSION_MAX_AGE_MS,
    });

    return { ok: true };
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    res.clearCookie(ADMIN_SESSION_COOKIE);
    return { ok: true };
  }

  @Get("me")
  me(@Req() req: Request): { isAdmin: boolean } {
    if (process.env.NODE_ENV !== "production") {
      return { isAdmin: true };
    }

    const expected = this.config.get("DISPATCH_PASSWORD", { infer: true });
    if (!expected) {
      return { isAdmin: false };
    }

    const cookieValue = parseCookieHeader(req.headers.cookie, ADMIN_SESSION_COOKIE);
    return { isAdmin: verifySession(cookieValue, sessionSecret(expected)) };
  }
}
```

```typescript
// backend/src/modules/auth/auth.module.ts
import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";

@Module({
  controllers: [AuthController],
})
export class AuthModule {}
```

Modify `backend/src/app.module.ts`: add the import alongside the other feature-module imports and register it.

```typescript
// near the other feature-module imports (after AutomationModule's import line)
import { AuthModule } from "./modules/auth/auth.module";
```

```typescript
// in the @Module imports array, after AutomationModule,
    AutomationModule,
    AuthModule,
```

Modify `backend/src/app.setup.ts`'s CORS setup so the cross-origin `admin_session` cookie is actually exchanged (frontend `:5173` and backend `:4000` are different origins in dev):

```typescript
  app.enableCors({
    origin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()),
    credentials: true,
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npm test -- src/modules/auth/auth.controller.spec.ts`
Expected: PASS (6 tests)

Then run the full backend suite to confirm nothing else broke:

Run: `cd backend && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/auth/dto/login.dto.ts backend/src/modules/auth/auth.controller.ts backend/src/modules/auth/auth.controller.spec.ts backend/src/modules/auth/auth.module.ts backend/src/app.module.ts backend/src/app.setup.ts
git commit -m "$(cat <<'EOF'
feat(auth): add /auth/login, /auth/logout, and /auth/me

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Frontend auth API client + `fetchJsonAdmin`

**Files:**
- Create: `frontend/src/data/authApi.ts`
- Modify: `frontend/src/data/benchmark/api.ts`
- Modify: `frontend/src/data/benchmark/api.test.ts`

**Interfaces:**
- Consumes: backend `GET /auth/me`, `POST /auth/login`, `POST /auth/logout` (Task 3).
- Produces: `fetchAuthMe(signal?): Promise<{ isAdmin: boolean }>`, `loginAdmin(password: string): Promise<void>`, `logoutAdmin(): Promise<void>` (consumed by Task 5's `AdminAuthContext`); `apiUrl` and `ADMIN_SESSION_EXPIRED_EVENT` exported from `api.ts` (the former consumed by `authApi.ts`, the latter by Task 5).

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/data/benchmark/api.test.ts` (new imports plus new `describe` blocks; keep the existing ones):

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_SESSION_EXPIRED_EVENT,
  deleteErroredRuns,
  deleteFailedJudgeCalls,
  fetchErroredRunCount,
  fetchFailedJudgeCallCount,
} from "./api";
```

Replace the `deleteErroredRuns` and `deleteFailedJudgeCalls` `describe` blocks with:

```typescript
  describe("deleteErroredRuns", () => {
    it("DELETEs /dispatch/runs/errored with credentials and the admin header", async () => {
      const calls = stubFetch({
        message: "Deleted 2 errored strategy run(s) and all related data",
        deletedRuns: 2,
        deletedGuesses: 11,
        deletedSolvePrompts: 22,
        deletedLlmProposals: 33,
        deletedCategoryEvaluations: 44,
      });

      const result = await deleteErroredRuns();

      expect(result.deletedRuns).toBe(2);
      expect(calls[0].url).toContain("/dispatch/runs/errored");
      expect(calls[0].init?.method).toBe("DELETE");
      expect(calls[0].init?.credentials).toBe("include");
      expect((calls[0].init?.headers as Record<string, string>)["X-Admin-Request"]).toBe("1");
    });

    it("rejects with a session-expired message and fires ADMIN_SESSION_EXPIRED_EVENT on a 403", async () => {
      stubFetchError(403, "Invalid or missing dispatch password.");
      const handler = vi.fn();
      window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);

      await expect(deleteErroredRuns()).rejects.toThrow("Session expired");
      expect(handler).toHaveBeenCalledOnce();

      window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);
    });
  });

  describe("deleteFailedJudgeCalls", () => {
    it("DELETEs /category-evaluation/failed with credentials and the admin header", async () => {
      const calls = stubFetch({
        message: "Deleted 7 failed judge call(s); the next dispatch will re-judge them",
        deleted: 7,
      });

      const result = await deleteFailedJudgeCalls();

      expect(result.deleted).toBe(7);
      expect(calls[0].url).toContain("/category-evaluation/failed");
      expect(calls[0].init?.method).toBe("DELETE");
      expect(calls[0].init?.credentials).toBe("include");
      expect((calls[0].init?.headers as Record<string, string>)["X-Admin-Request"]).toBe("1");
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm test -- src/data/benchmark/api.test.ts`
Expected: FAIL — `deleteErroredRuns`/`deleteFailedJudgeCalls` still require a `password` argument and there's no `ADMIN_SESSION_EXPIRED_EVENT` export

- [ ] **Step 3: Write the implementation**

In `frontend/src/data/benchmark/api.ts`:

Change the private `apiUrl` to exported:

```typescript
export const apiUrl = (path: string) => `${import.meta.env.VITE_API_URL}${path}`;
```

Add, right after `fetchJson`:

```typescript
/** Fired whenever an admin-only call gets a 401/403 back — the session
 * cookie is missing or expired. AdminAuthProvider (see auth/AdminAuthContext)
 * listens for this to flip `isAdmin` false immediately, without waiting for
 * a manual /auth/me refresh. */
export const ADMIN_SESSION_EXPIRED_EVENT = "admin-session-expired";

const ADMIN_REQUEST_HEADER = "X-Admin-Request";

/** Like fetchJson, but for the admin-only actions gated by DispatchAuthGuard
 * — sends the session cookie and the CSRF marker header it requires (see
 * session.ts on the backend), and turns a 401/403 into a clear "log in
 * again" message instead of the backend's generic guard-rejection text. */
async function fetchJsonAdmin<T>(path: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    signal,
    credentials: "include",
    headers: { ...init?.headers, [ADMIN_REQUEST_HEADER]: "1" },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
      throw new Error("Session expired — log in again at /admin-login.");
    }
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? `Request failed with status ${res.status}`);
  }

  return res.json();
}
```

Replace the five admin-mutating functions' bodies:

```typescript
export function deleteErroredRuns(signal?: AbortSignal): Promise<DeleteErroredRunsResult> {
  return fetchJsonAdmin("/dispatch/runs/errored", signal, { method: "DELETE" });
}
```

```typescript
export function deleteFailedJudgeCalls(signal?: AbortSignal): Promise<DeleteFailedJudgeCallsResult> {
  return fetchJsonAdmin("/category-evaluation/failed", signal, { method: "DELETE" });
}
```

```typescript
export function startFreeTierDispatch(
  tier: FreeTierId,
  thresholdPercent: number,
  signal?: AbortSignal,
): Promise<FreeTierDispatchStatus> {
  return fetchJsonAdmin(`/dispatch/free-tier/${tier}?threshold=${thresholdPercent}`, signal, {
    method: "POST",
  });
}
```

```typescript
export function startBothFreeTierDispatch(
  thresholdPercent: number,
  signal?: AbortSignal,
): Promise<FreeTierDispatchBothStartResult> {
  return fetchJsonAdmin(`/dispatch/free-tier/both?threshold=${thresholdPercent}`, signal, {
    method: "POST",
  });
}
```

```typescript
export function deleteRun(runId: number, signal?: AbortSignal): Promise<DeleteRunResult> {
  return fetchJsonAdmin(`/dispatch/run/${runId}`, signal, { method: "DELETE" });
}
```

(Each of the five drops its old `password: string` parameter and its `headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password })` — the doc comments above each that reference "harmless to send blank elsewhere" should be trimmed to drop the now-false claim about `password`.)

Create `frontend/src/data/authApi.ts`:

```typescript
import { apiUrl } from "./benchmark/api";

export interface AdminMe {
  isAdmin: boolean;
}

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), { ...init, credentials: "include" });
}

/** Whether this browser session is currently logged in as admin. Never
 * rejects — a network failure or non-2xx response both just mean "not
 * admin," which is the safe default to render. */
export async function fetchAuthMe(signal?: AbortSignal): Promise<AdminMe> {
  try {
    const res = await authFetch("/auth/me", { signal });
    if (!res.ok) return { isAdmin: false };
    return await res.json();
  } catch {
    return { isAdmin: false };
  }
}

/** Logs in against DISPATCH_PASSWORD — on success the backend sets the
 * signed admin_session cookie. Rejects (thrown Error, backend message) on a
 * wrong password. */
export async function loginAdmin(password: string): Promise<void> {
  const res = await authFetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message ?? "Incorrect password.");
  }
}

/** Clears the admin_session cookie. Never rejects — logging out an
 * already-logged-out session is a no-op either way. */
export async function logoutAdmin(): Promise<void> {
  await authFetch("/auth/logout", { method: "POST" }).catch(() => {});
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test -- src/data/benchmark/api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/data/authApi.ts frontend/src/data/benchmark/api.ts frontend/src/data/benchmark/api.test.ts
git commit -m "$(cat <<'EOF'
feat(frontend): add admin auth API client and fetchJsonAdmin

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `AdminAuthContext`

**Files:**
- Create: `frontend/src/auth/AdminAuthContext.tsx`
- Create: `frontend/src/auth/__tests__/AdminAuthContext.test.tsx`

**Interfaces:**
- Consumes: `fetchAuthMe`, `loginAdmin`, `logoutAdmin` (Task 4's `data/authApi.ts`), `ADMIN_SESSION_EXPIRED_EVENT` (Task 4's `data/benchmark/api.ts`).
- Produces: `AdminAuthContext` (React context, exported for tests to override directly via `.Provider`), `AdminAuthProvider({ children })`, `useAdminAuth(): { isAdmin: boolean; isLoading: boolean; login(password): Promise<void>; logout(): Promise<void> }` — consumed by Tasks 6, 8, 9, 10, 11.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/auth/__tests__/AdminAuthContext.test.tsx
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SESSION_EXPIRED_EVENT } from "../../data/benchmark/api";
import { AdminAuthProvider, useAdminAuth } from "../AdminAuthContext";

function Probe() {
  const { isAdmin, isLoading, login, logout } = useAdminAuth();
  return (
    <div>
      <span>isAdmin: {String(isAdmin)}</span>
      <span>isLoading: {String(isLoading)}</span>
      <button onClick={() => login("hunter2").catch(() => {})}>login</button>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

function stubFetch(meIsAdmin: boolean, loginOk = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const href = String(url);
      if (href.includes("/auth/login")) {
        return Promise.resolve({
          ok: loginOk,
          status: loginOk ? 200 : 403,
          json: async () => (loginOk ? { ok: true } : { message: "Incorrect password." }),
        });
      }
      if (href.includes("/auth/logout")) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ isAdmin: meIsAdmin }) });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminAuthProvider", () => {
  it("starts loading, then reflects /auth/me", async () => {
    stubFetch(true);
    render(
      <AdminAuthProvider>
        <Probe />
      </AdminAuthProvider>,
    );

    expect(screen.getByText("isLoading: true")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("isLoading: false")).toBeInTheDocument());
    expect(screen.getByText("isAdmin: true")).toBeInTheDocument();
  });

  it("flips isAdmin true after a successful login", async () => {
    const user = userEvent.setup();
    stubFetch(false);
    render(
      <AdminAuthProvider>
        <Probe />
      </AdminAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("isLoading: false")).toBeInTheDocument());

    await user.click(screen.getByText("login"));
    await waitFor(() => expect(screen.getByText("isAdmin: true")).toBeInTheDocument());
  });

  it("flips isAdmin false on logout", async () => {
    const user = userEvent.setup();
    stubFetch(true);
    render(
      <AdminAuthProvider>
        <Probe />
      </AdminAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("isAdmin: true")).toBeInTheDocument());

    await user.click(screen.getByText("logout"));
    await waitFor(() => expect(screen.getByText("isAdmin: false")).toBeInTheDocument());
  });

  it("flips isAdmin false when ADMIN_SESSION_EXPIRED_EVENT fires", async () => {
    stubFetch(true);
    render(
      <AdminAuthProvider>
        <Probe />
      </AdminAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("isAdmin: true")).toBeInTheDocument());

    act(() => {
      window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
    });

    expect(screen.getByText("isAdmin: false")).toBeInTheDocument();
  });
});

describe("useAdminAuth without a provider", () => {
  it("defaults to a logged-out, non-loading state", () => {
    render(<Probe />);
    expect(screen.getByText("isAdmin: false")).toBeInTheDocument();
    expect(screen.getByText("isLoading: false")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm test -- src/auth/__tests__/AdminAuthContext.test.tsx`
Expected: FAIL — `Cannot find module '../AdminAuthContext'`

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/auth/AdminAuthContext.tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ADMIN_SESSION_EXPIRED_EVENT } from "../data/benchmark/api";
import { fetchAuthMe, loginAdmin, logoutAdmin } from "../data/authApi";

export interface AdminAuthValue {
  /** Whether this browser session is currently logged in as admin. Always
   * true outside production (see backend AuthController.me) and false while
   * the initial /auth/me check is still in flight. */
  isAdmin: boolean;
  /** True only until the first /auth/me check resolves. */
  isLoading: boolean;
  /** Logs in against DISPATCH_PASSWORD; rejects (thrown Error, backend
   * message) on a wrong password. Refreshes isAdmin on success. */
  login: (password: string) => Promise<void>;
  /** Clears the session cookie and flips isAdmin false. */
  logout: () => Promise<void>;
}

const defaultValue: AdminAuthValue = {
  isAdmin: false,
  isLoading: false,
  login: async () => {},
  logout: async () => {},
};

/** Exported (not just the hook below) so tests can override it directly via
 * `<AdminAuthContext.Provider value={...}>` without going through a real
 * login flow. */
export const AdminAuthContext = createContext<AdminAuthValue>(defaultValue);

/** Reads the current admin session — defaults to a logged-out, non-loading
 * state when no AdminAuthProvider is mounted (e.g. a component rendered in
 * isolation in a test), so consumers never need to guard against a missing
 * provider. */
export function useAdminAuth(): AdminAuthValue {
  return useContext(AdminAuthContext);
}

/** Mounted once near the app root (see main.tsx). Checks /auth/me on mount
 * to learn whether this browser already holds a valid session cookie, and
 * listens for ADMIN_SESSION_EXPIRED_EVENT (dispatched by api.ts's
 * fetchJsonAdmin on a 401/403) to flip isAdmin false the moment a session
 * goes stale. */
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    const { isAdmin: admin } = await fetchAuthMe();
    setIsAdmin(admin);
  }, []);

  useEffect(() => {
    refresh().finally(() => setIsLoading(false));
  }, [refresh]);

  useEffect(() => {
    function handleExpired() {
      setIsAdmin(false);
    }
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, handleExpired);
  }, []);

  const login = useCallback(
    async (password: string) => {
      await loginAdmin(password);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await logoutAdmin();
    setIsAdmin(false);
  }, []);

  return (
    <AdminAuthContext.Provider value={{ isAdmin, isLoading, login, logout }}>
      {children}
    </AdminAuthContext.Provider>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test -- src/auth/__tests__/AdminAuthContext.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/auth/AdminAuthContext.tsx frontend/src/auth/__tests__/AdminAuthContext.test.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): add AdminAuthContext

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Hidden `/admin-login` page

**Files:**
- Create: `frontend/src/pages/AdminLoginPage.tsx`
- Create: `frontend/src/pages/__tests__/AdminLoginPage.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/main.tsx`

**Interfaces:**
- Consumes: `useAdminAuth` (Task 5).
- Produces: `AdminLoginPage` component, mounted at route `/admin-login` (not linked from `Header.tsx`'s nav).

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/pages/__tests__/AdminLoginPage.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAuthProvider } from "../../auth/AdminAuthContext";
import { AdminLoginPage } from "../AdminLoginPage";

function stubFetch(login: { ok: boolean; status?: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const href = String(url);
      if (href.includes("/auth/login")) {
        return Promise.resolve({
          ok: login.ok,
          status: login.status ?? 200,
          json: async () => login.body,
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ isAdmin: false }) });
    }),
  );
}

function renderPage() {
  render(
    <AdminAuthProvider>
      <MemoryRouter initialEntries={["/admin-login"]}>
        <Routes>
          <Route path="/admin-login" element={<AdminLoginPage />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>
    </AdminAuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminLoginPage", () => {
  it("logs in and navigates home on the correct password", async () => {
    const user = userEvent.setup();
    stubFetch({ ok: true, body: { ok: true } });
    renderPage();

    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("home")).toBeInTheDocument();
  });

  it("shows the backend's error message on a wrong password", async () => {
    const user = userEvent.setup();
    stubFetch({ ok: false, status: 403, body: { message: "Incorrect password." } });
    renderPage();

    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Incorrect password.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm test -- src/pages/__tests__/AdminLoginPage.test.tsx`
Expected: FAIL — `Cannot find module '../AdminLoginPage'`

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/pages/AdminLoginPage.tsx
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAdminAuth } from "../auth/AdminAuthContext";

/** Hidden login form for the site's one admin identity — not linked from
 * site navigation (see Header.tsx); reached only by visiting /admin-login
 * directly. On success the backend sets a 90-day session cookie and every
 * admin-only control elsewhere in the app becomes visible. */
export function AdminLoginPage() {
  const { login } = useAdminAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await login(password);
      navigate("/");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="bench-page">
      <header className="bench-page-header">
        <h1 className="bench-page-header__title">Admin login</h1>
      </header>

      <form onSubmit={handleSubmit}>
        <label className="bench-modal__field">
          Password
          <input
            type="password"
            className="bench-modal__number"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error ? <p className="bench-error">{error}</p> : null}

        <button type="submit" className="bench-btn-primary" disabled={isSubmitting || !password}>
          {isSubmitting ? "Logging in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}
```

Modify `frontend/src/App.tsx`: add the lazy import alongside the other lazy pages, and the route inside the existing `SiteLayout` route group.

```tsx
const AdminLoginPage = lazy(() =>
  import("./pages/AdminLoginPage").then((m) => ({ default: m.AdminLoginPage })),
);
```

```tsx
        <Route
          path="admin-login"
          element={
            <Suspense fallback={<RouteFallback />}>
              <AdminLoginPage />
            </Suspense>
          }
        />
```
(placed after the existing `maintenance` route, still inside `<Route element={<SiteLayout />}>`)

Modify `frontend/src/main.tsx` to mount the provider around the router:

```tsx
import { AdminAuthProvider } from "./auth/AdminAuthContext.tsx";
```

```tsx
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AdminAuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AdminAuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test -- src/pages/__tests__/AdminLoginPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/AdminLoginPage.tsx frontend/src/pages/__tests__/AdminLoginPage.test.tsx frontend/src/App.tsx frontend/src/main.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): add hidden /admin-login page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Drop the password field from the three modals

**Files:**
- Modify: `frontend/src/components/benchmark/DeleteRunModal.tsx`
- Modify: `frontend/src/components/benchmark/__tests__/DeleteRunModal.test.tsx`
- Modify: `frontend/src/components/benchmark/FreeTierDispatchModal.tsx`
- Modify: `frontend/src/components/benchmark/BulkActionModal.tsx`
- Modify: `frontend/src/components/benchmark/__tests__/BulkActionModal.test.tsx`
- Modify: `frontend/src/components/benchmark/MaintenancePanel.tsx`

**Interfaces:**
- Consumes: `deleteRun`, `startFreeTierDispatch`, `startBothFreeTierDispatch`, `deleteErroredRuns`, `deleteFailedJudgeCalls` (Task 4's new zero-password signatures).
- Produces: `BulkActionModalProps.action: () => Promise<{ message: string }>` (was `(password: string) => ...`) — no other file consumes `BulkActionModal` besides `MaintenancePanel.tsx`, updated in this same task.

- [ ] **Step 1: Write the failing tests**

Replace the "submits the password" test in `frontend/src/components/benchmark/__tests__/DeleteRunModal.test.tsx`:

```tsx
  it("DELETEs /dispatch/run/:runId with the admin session, then reports the deletion and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    stubFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return deletedResult;
    });

    render(<DeleteRunModal runId={12292} onClose={onClose} onDeleted={onDeleted} />);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDeleted).toHaveBeenCalledWith(deletedResult);
    expect(capturedUrl).toContain("/dispatch/run/12292");
    expect(capturedInit?.method).toBe("DELETE");
    expect(capturedInit?.credentials).toBe("include");
    expect((capturedInit?.headers as Record<string, string>)["X-Admin-Request"]).toBe("1");
  });
```

(The `user.type(screen.getByLabelText("Password"), "hunter2")` line from the old version is removed — there's no password field to type into.)

Replace `frontend/src/components/benchmark/__tests__/BulkActionModal.test.tsx`'s second test and drop the password assertion from its fourth:

```tsx
  it("runs the action, then shows its result message and reports done", async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockResolvedValue({ message: "Deleted 3 errored strategy run(s)" });
    const onDone = vi.fn();

    render(
      <BulkActionModal
        title="Delete errored runs"
        warning="warning"
        action={action}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Deleted 3 errored strategy run(s)")).toBeInTheDocument();
    expect(action).toHaveBeenCalledWith();
    expect(onDone).toHaveBeenCalledWith("Deleted 3 errored strategy run(s)");
  });
```

```tsx
  it("shows the thrown error message and stays open when the action fails", async () => {
    const user = userEvent.setup();
    const action = vi.fn().mockRejectedValue(new Error("The action failed."));
    const onClose = vi.fn();

    render(<BulkActionModal title="t" warning="w" action={action} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("The action failed.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
```

(the trailing `expect(screen.getByLabelText("Password")).toBeInTheDocument();` line is removed, and the error message changed since it no longer needs to sound password-specific)

Add a new test confirming the field is gone:

```tsx
  it("has no password field", () => {
    render(<BulkActionModal title="t" warning="w" action={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm test -- src/components/benchmark/__tests__/DeleteRunModal.test.tsx src/components/benchmark/__tests__/BulkActionModal.test.tsx`
Expected: FAIL — the components still require/render a password field and the API functions still take one

- [ ] **Step 3: Write the implementation**

In `frontend/src/components/benchmark/DeleteRunModal.tsx`: remove the `password` state (and its comment), remove the password `<label>` block from the JSX, and change the submit call to `const result = await deleteRun(runId);`.

In `frontend/src/components/benchmark/FreeTierDispatchModal.tsx`: remove the `password` state (and its comment), remove the password `<label>` block from the JSX, and change the two calls to `await startBothFreeTierDispatch(threshold);` and `await startFreeTierDispatch(tier, threshold);`.

In `frontend/src/components/benchmark/BulkActionModal.tsx`:

```tsx
export interface BulkActionModalProps {
  /** Modal heading — names the destructive bulk action, e.g. "Delete errored runs". */
  title: string;
  /** Red permanence warning shown above the actions. */
  warning: string;
  /** Confirm button label. Defaults to "Delete". */
  confirmLabel?: string;
  /** The actual bulk call. Resolves with the backend's response (its
   * `message` is shown on success); rejects with an Error whose message is
   * surfaced in-place. Auth travels via the admin session cookie (see
   * AdminAuthContext), not a password argument. */
  action: () => Promise<{ message: string }>;
  onClose: () => void;
  /** Called once with the backend's message after the action succeeds — the
   * maintenance panel uses this to refetch its counts. */
  onDone?: (message: string) => void;
}
```

Remove the `password` state and its `<label>` block; change `handleSubmit` to call `await action();` and drop the `useState` import for it if unused elsewhere (it's still used for `isSubmitting`/`error`/`resultMessage`, so the `useState` import itself stays — only the one `password` state line is removed).

In `frontend/src/components/benchmark/MaintenancePanel.tsx`, change the two modal usages:

```tsx
          action={deleteErroredRuns}
```

```tsx
          action={deleteFailedJudgeCalls}
```

(replacing `action={(password) => deleteErroredRuns(password)}` and `action={(password) => deleteFailedJudgeCalls(password)}`)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test -- src/components/benchmark/__tests__/DeleteRunModal.test.tsx src/components/benchmark/__tests__/BulkActionModal.test.tsx src/components/benchmark/__tests__/FreeTierDispatchModal.test.tsx src/components/benchmark/__tests__/MaintenancePanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/benchmark/DeleteRunModal.tsx frontend/src/components/benchmark/__tests__/DeleteRunModal.test.tsx frontend/src/components/benchmark/FreeTierDispatchModal.tsx frontend/src/components/benchmark/BulkActionModal.tsx frontend/src/components/benchmark/__tests__/BulkActionModal.test.tsx frontend/src/components/benchmark/MaintenancePanel.tsx
git commit -m "$(cat <<'EOF'
refactor(frontend): drop the password field from admin action modals

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `Header.tsx` — admin-only Maintenance link and Log out

**Files:**
- Modify: `frontend/src/components/Header.tsx`
- Modify: `frontend/src/components/__tests__/Header.test.tsx`

**Interfaces:**
- Consumes: `useAdminAuth`, `AdminAuthContext` (Task 5).

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/components/__tests__/Header.test.tsx`:

```tsx
import { AdminAuthContext } from "../../auth/AdminAuthContext";
```

```tsx
function renderHeaderAsAdmin(initialEntry = "/leaderboard") {
  return render(
    <AdminAuthContext.Provider
      value={{ isAdmin: true, isLoading: false, login: vi.fn(), logout: vi.fn() }}
    >
      <MemoryRouter initialEntries={[initialEntry]}>
        <Header />
      </MemoryRouter>
    </AdminAuthContext.Provider>,
  );
}
```

```tsx
  it("hides the Maintenance link and Log out button for a non-admin visitor", () => {
    renderHeader();

    expect(screen.queryByRole("link", { name: "Maintenance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  });

  it("shows the Maintenance link and Log out button for an admin session", () => {
    renderHeaderAsAdmin();

    expect(screen.getByRole("link", { name: "Maintenance" })).toHaveAttribute(
      "href",
      "/maintenance",
    );
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("calls logout when the Log out button is clicked", async () => {
    const user = userEvent.setup();
    const logout = vi.fn();
    render(
      <AdminAuthContext.Provider value={{ isAdmin: true, isLoading: false, login: vi.fn(), logout }}>
        <MemoryRouter initialEntries={["/leaderboard"]}>
          <Header />
        </MemoryRouter>
      </AdminAuthContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(logout).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd frontend && npm test -- src/components/__tests__/Header.test.tsx`
Expected: the pre-existing tests PASS; the 3 new ones FAIL (Maintenance link and Log out aren't gated/present yet)

- [ ] **Step 3: Write the implementation**

In `frontend/src/components/Header.tsx`, add the import and gate the Maintenance link, adding a Log out control:

```tsx
import { useAdminAuth } from "../auth/AdminAuthContext";
```

```tsx
export function Header() {
  const { isAdmin, logout } = useAdminAuth();
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  // ...unchanged...
```

Replace the always-rendered Maintenance `NavLink` with:

```tsx
        {isAdmin ? (
          <NavLink to="/maintenance" className={navLinkClass} aria-label="Maintenance">
            <WrenchIcon />
            <span className="site-header__link-label">Maintenance</span>
          </NavLink>
        ) : null}

        {isAdmin ? (
          <button
            type="button"
            className="site-header__icon-btn"
            aria-label="Log out"
            onClick={() => void logout()}
          >
            Log out
          </button>
        ) : null}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test -- src/components/__tests__/Header.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Header.tsx frontend/src/components/__tests__/Header.test.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): hide the Maintenance nav link from non-admin visitors

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `ActivityPage.tsx` — gate the operational widget row

**Files:**
- Modify: `frontend/src/pages/benchmark/ActivityPage.tsx`
- Modify: `frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx`
- Modify: `frontend/src/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: `useAdminAuth`, `AdminAuthContext`, `AdminAuthProvider` (Task 5).

- [ ] **Step 1: Write the failing tests**

In `frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx`, add the import and wrap the existing `renderActivity` helper in an admin context, then add a new non-admin `describe` block:

```tsx
import { AdminAuthContext } from "../../../auth/AdminAuthContext";
```

```tsx
function renderActivity() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <AdminAuthContext.Provider
      value={{ isAdmin: true, isLoading: false, login: vi.fn(), logout: vi.fn() }}
    >
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/activity"]}>
          <Routes>
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/leaderboard/:strategyId/:puzzleId" element={<div>run-page</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </AdminAuthContext.Provider>,
  );
}
```

(every pre-existing test in the file keeps calling `renderActivity()` unchanged — they now run as an admin, matching what they were actually testing)

```tsx
describe("ActivityPage as a non-admin visitor", () => {
  function renderActivityAsViewer() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/activity"]}>
          <ActivityPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("hides the operational widget row and the Enable Auto-Dispatch button", async () => {
    stubFetch();
    renderActivityAsViewer();

    expect(await screen.findByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(screen.queryByText("Flagship daily tokens")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable Auto-Dispatch" })).not.toBeInTheDocument();
  });

  it("still shows Recent Activity", async () => {
    stubFetch({ recentActivity: [] });
    renderActivityAsViewer();

    expect(await screen.findByText("No activity yet.")).toBeInTheDocument();
  });
});
```

In `frontend/src/__tests__/App.test.tsx`, add the import and wrap `renderApp`:

```tsx
import { AdminAuthProvider } from "../auth/AdminAuthContext";
```

```tsx
function renderApp(initialEntries: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AdminAuthProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <App />
        </MemoryRouter>
      </AdminAuthProvider>
    </QueryClientProvider>,
  );
}
```

Replace the `"renders the free-tier budget widgets at /activity"` test:

```tsx
  it("renders the free-tier budget widgets at /activity for an admin session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const href = String(url);
        if (href.includes("/auth/me")) {
          return Promise.resolve({ ok: true, json: async () => ({ isAdmin: true }) });
        }
        if (href.includes("/strategy/free-tier-usage/flagship")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              tier: "flagship",
              label: "Flagship models",
              usedTokens: 0,
              dailyLimitTokens: 250_000,
              remainingTokens: 250_000,
              models: [],
            }),
          });
        }
        if (href.includes("/strategy/free-tier-usage/mini")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              tier: "mini",
              label: "Mini & nano models",
              usedTokens: 0,
              dailyLimitTokens: 2_500_000,
              remainingTokens: 2_500_000,
              models: [],
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({ deterministic: [], llm: [] }) });
      }),
    );

    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(await screen.findByText("Flagship daily tokens")).toBeInTheDocument();
    expect(screen.getByText("Mini & nano daily tokens")).toBeInTheDocument();
  });

  it("hides the operational widgets at /activity for a non-admin visitor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const href = String(url);
        if (href.includes("/auth/me")) {
          return Promise.resolve({ ok: true, json: async () => ({ isAdmin: false }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ deterministic: [], llm: [] }) });
      }),
    );

    renderApp(["/activity"]);

    expect(await screen.findByRole("heading", { name: "Activity" })).toBeInTheDocument();
    expect(screen.queryByText("Flagship daily tokens")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd frontend && npm test -- src/pages/benchmark/__tests__/ActivityPage.test.tsx src/__tests__/App.test.tsx`
Expected: the new non-admin tests FAIL (widgets still render unconditionally); other tests should still PASS since `renderActivity`/`renderApp` now supply `isAdmin: true`

- [ ] **Step 3: Write the implementation**

In `frontend/src/pages/benchmark/ActivityPage.tsx`:

```tsx
import { useAdminAuth } from "../../auth/AdminAuthContext";
```

```tsx
export function ActivityPage() {
  const { isAdmin } = useAdminAuth();
  const [isDispatchModalOpen, setIsDispatchModalOpen] = useState(false);
  const [dispatchRefreshSignal, setDispatchRefreshSignal] = useState(0);

  const { data: leaderboard } = useQuery({
    queryKey: ["leaderboard"],
    queryFn: ({ signal }) => fetchLeaderboard(signal),
    enabled: isAdmin,
  });

  const freeTierModels = useQueries({
    queries: (["flagship", "mini"] as const).map((tier) => ({
      queryKey: ["free-tier-usage", tier],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchFreeTierUsage(tier, signal),
      enabled: isAdmin,
    })),
    combine: (results): FreeTierModelSets => ({
      flagship: new Set(results[0].data?.models ?? []),
      mini: new Set(results[1].data?.models ?? []),
    }),
  });
```

```tsx
  const { data: automationStatus } = useQuery({
    queryKey: ["automation-status"],
    queryFn: ({ signal }) => fetchAutomationStatus(signal),
    refetchInterval: 30_000,
    enabled: isAdmin,
  });
```

Gate the button and the widget row in the JSX:

```tsx
          {isAdmin ? (
            <button
              type="button"
              className="bench-btn-primary"
              onClick={() => setIsDispatchModalOpen(true)}
            >
              Enable Auto-Dispatch
            </button>
          ) : null}
        </div>
      </header>

      {isAdmin ? (
        <div className="bench-free-tiers" aria-label="Daily free-token budgets">
          <FreeTierBudgetWidget
            tier="flagship"
            spentUsd={flagshipSpentUsd}
            refreshSignal={dispatchRefreshSignal}
          />
          <FreeTierBudgetWidget
            tier="mini"
            spentUsd={miniSpentUsd}
            refreshSignal={dispatchRefreshSignal}
            automation={miniBurnAutomation}
          />
          <CategoryJudgingWidget automation={judgeAutomation} />
          <GoogleDispatchWidget automation={googleBurnAutomation} />
        </div>
      ) : null}
```

(the `isDispatchModalOpen` modal render, and the `RecentActivityTable` section below, are unchanged)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test -- src/pages/benchmark/__tests__/ActivityPage.test.tsx src/__tests__/App.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/benchmark/ActivityPage.tsx frontend/src/pages/benchmark/__tests__/ActivityPage.test.tsx frontend/src/__tests__/App.test.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): hide Activity page operational widgets from non-admins

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `MaintenancePage.tsx` — not-found for non-admins

**Files:**
- Modify: `frontend/src/pages/benchmark/MaintenancePage.tsx`
- Create: `frontend/src/pages/benchmark/__tests__/MaintenancePage.test.tsx`
- Modify: `frontend/src/__tests__/App.test.tsx`

**Interfaces:**
- Consumes: `useAdminAuth`, `AdminAuthContext` (Task 5).

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/pages/benchmark/__tests__/MaintenancePage.test.tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAuthContext } from "../../../auth/AdminAuthContext";
import { MaintenancePage } from "../MaintenancePage";

function renderPage(isAdmin: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <AdminAuthContext.Provider
      value={{ isAdmin, isLoading: false, login: vi.fn(), logout: vi.fn() }}
    >
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/maintenance"]}>
          <MaintenancePage />
        </MemoryRouter>
      </QueryClientProvider>
    </AdminAuthContext.Provider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MaintenancePage", () => {
  it("renders the panel for an admin session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ erroredRuns: 0, failed: 0 }) })),
    );
    renderPage(true);

    expect(await screen.findByRole("heading", { name: "Maintenance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bulk cleanup" })).toBeInTheDocument();
  });

  it("shows a not-found message for a non-admin visitor", () => {
    renderPage(false);

    expect(screen.getByText("Not found.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Maintenance" })).not.toBeInTheDocument();
  });
});
```

Replace the existing `"renders the maintenance panel at /maintenance"` test in `frontend/src/__tests__/App.test.tsx`:

```tsx
  it("renders the maintenance panel at /maintenance for an admin session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const href = String(url);
        if (href.includes("/auth/me")) {
          return Promise.resolve({ ok: true, json: async () => ({ isAdmin: true }) });
        }
        if (href.includes("/dispatch/runs/errored")) {
          return Promise.resolve({ ok: true, json: async () => ({ erroredRuns: 2 }) });
        }
        if (href.includes("/category-evaluation/failed")) {
          return Promise.resolve({ ok: true, json: async () => ({ failed: 5 }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );

    renderApp(["/maintenance"]);

    expect(await screen.findByRole("heading", { name: "Bulk cleanup" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /delete errored runs/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete failed judge calls/i })).toBeInTheDocument();
  });

  it("hides the maintenance panel behind a not-found for a non-admin visitor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        const href = String(url);
        if (href.includes("/auth/me")) {
          return Promise.resolve({ ok: true, json: async () => ({ isAdmin: false }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }),
    );

    renderApp(["/maintenance"]);

    expect(await screen.findByText("Not found.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Bulk cleanup" })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npm test -- src/pages/benchmark/__tests__/MaintenancePage.test.tsx src/__tests__/App.test.tsx`
Expected: FAIL — `MaintenancePage` renders the panel unconditionally, there's no "Not found." case

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/pages/benchmark/MaintenancePage.tsx
import { Link } from "react-router-dom";
import { useAdminAuth } from "../../auth/AdminAuthContext";
import { MaintenancePanel } from "../../components/benchmark/MaintenancePanel";

/** Destructive bulk-cleanup actions, kept on their own route so they're
 * away from the day-to-day dashboards: clear out errored strategy runs, and
 * clear out failed category-judge calls so they get re-judged. Admin-only —
 * a non-admin visitor (or one whose session expired) sees the same
 * not-found treatment as an unknown route, not the panel. */
export function MaintenancePage() {
  const { isAdmin, isLoading } = useAdminAuth();

  if (isLoading) {
    return (
      <div className="bench-page">
        <p className="bench-muted">Loading…</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="bench-page">
        <p className="bench-muted">Not found.</p>
        <Link to="/" className="bench-page-header__back">
          ← Back home
        </Link>
      </div>
    );
  }

  return (
    <div className="bench-page">
      <header className="bench-page-header">
        <div className="bench-page-header__title-block">
          <h1 className="bench-page-header__title">Maintenance</h1>
          <p className="bench-strategy-desc">
            One-shot cleanup for data left behind by since-fixed bugs. Every action here is
            permanent.
          </p>
        </div>
      </header>

      <MaintenancePanel />
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test -- src/pages/benchmark/__tests__/MaintenancePage.test.tsx src/__tests__/App.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/benchmark/MaintenancePage.tsx frontend/src/pages/benchmark/__tests__/MaintenancePage.test.tsx frontend/src/__tests__/App.test.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): not-found the Maintenance page for non-admin visitors

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `GuessChainVisualizer` — admin-gate "Delete this run"

**Files:**
- Modify: `frontend/src/components/benchmark/GuessChainVisualizer.tsx`
- Modify: `frontend/src/components/benchmark/__tests__/GuessChainVisualizer.test.tsx`

**Interfaces:**
- Consumes: `useAdminAuth`, `AdminAuthContext` (Task 5).

`GuessChainVisualizer` is reachable from `PuzzleRunsPage`, which — unlike Activity/Maintenance — stays visible to everyone (viewers can browse run detail). Only its "Delete this run" button (shown today whenever `detail?.status === "error"`) needs gating; the page around it does not.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/components/benchmark/__tests__/GuessChainVisualizer.test.tsx`, add the import and a helper, then update the delete-button tests:

```tsx
import { AdminAuthContext } from "../../../auth/AdminAuthContext";
```

```tsx
function renderAsAdmin(ui: Parameters<typeof render>[0]) {
  return render(
    <AdminAuthContext.Provider
      value={{ isAdmin: true, isLoading: false, login: vi.fn(), logout: vi.fn() }}
    >
      {ui}
    </AdminAuthContext.Provider>,
  );
}
```

Replace the three delete-related tests and add a fourth:

```tsx
  it("shows a 'Delete this run' button only when the run's status is 'error' for an admin session", async () => {
    stubFetch({ ...plainDetail, status: "error" });

    renderAsAdmin(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByRole("button", { name: "Delete this run" })).toBeInTheDocument();
  });

  it("does not show the delete button for a non-error status", async () => {
    stubFetch({ ...plainDetail, status: "completed" });

    renderAsAdmin(<GuessChainVisualizer runId={12345} />);

    await screen.findByText("APPLE, BANANA, CHERRY, DATE");
    expect(screen.queryByRole("button", { name: "Delete this run" })).not.toBeInTheDocument();
  });

  it("does not show the delete button for a non-admin visitor, even on an errored run", async () => {
    stubFetch({ ...plainDetail, status: "error" });

    render(<GuessChainVisualizer runId={12345} />);

    await screen.findByText("APPLE, BANANA, CHERRY, DATE");
    expect(screen.queryByRole("button", { name: "Delete this run" })).not.toBeInTheDocument();
  });

  it("opens the delete-run modal when the delete button is clicked", async () => {
    const user = userEvent.setup();
    stubFetch({ ...plainDetail, status: "error" });

    renderAsAdmin(<GuessChainVisualizer runId={12345} />);

    await user.click(await screen.findByRole("button", { name: "Delete this run" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /12345/ })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `cd frontend && npm test -- src/components/benchmark/__tests__/GuessChainVisualizer.test.tsx`
Expected: the first, second, and fourth tests PASS unchanged (the button currently shows regardless of admin status); the third ("non-admin visitor") FAILS — the button still renders

- [ ] **Step 3: Write the implementation**

In `frontend/src/components/benchmark/GuessChainVisualizer.tsx`:

```tsx
import { useAdminAuth } from "../../auth/AdminAuthContext";
```

```tsx
export function GuessChainVisualizer({ runId, onDeleted }: GuessChainVisualizerProps) {
  const { isAdmin } = useAdminAuth();
  const [detail, setDetail] = useState<StrategyRunDetail | null>(null);
  // ...unchanged...
```

```tsx
        {isAdmin && detail?.status === "error" ? (
          <button
            type="button"
            className="bench-sort-btn bench-sort-btn--danger"
            onClick={() => setShowDeleteModal(true)}
          >
            Delete this run
          </button>
        ) : null}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npm test -- src/components/benchmark/__tests__/GuessChainVisualizer.test.tsx`
Expected: PASS

Then run the full frontend suite to confirm nothing else broke:

Run: `cd frontend && npm test -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/benchmark/GuessChainVisualizer.tsx frontend/src/components/benchmark/__tests__/GuessChainVisualizer.test.tsx
git commit -m "$(cat <<'EOF'
feat(frontend): admin-gate the 'Delete this run' button

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
