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
