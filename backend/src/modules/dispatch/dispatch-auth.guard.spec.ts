import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DispatchAuthGuard } from "./dispatch-auth.guard";

function makeContext(body: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ body }),
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
});
