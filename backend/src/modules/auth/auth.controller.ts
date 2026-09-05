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
