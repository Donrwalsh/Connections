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
