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
