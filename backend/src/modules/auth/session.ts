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
