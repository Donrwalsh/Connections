# Admin session auth — design

## Problem

Every destructive/paid-provider action in the benchmark UI is gated by a
one-off password field, checked per-request against `DISPATCH_PASSWORD`:

- [FreeTierDispatchModal.tsx](../../../frontend/src/components/benchmark/FreeTierDispatchModal.tsx)
  and [DeleteRunModal.tsx](../../../frontend/src/components/benchmark/DeleteRunModal.tsx)
  ("Enable Auto-Dispatch," "Delete run") each carry their own password input.
- [BulkActionModal.tsx](../../../frontend/src/components/benchmark/BulkActionModal.tsx),
  used by [MaintenancePanel.tsx](../../../frontend/src/components/benchmark/MaintenancePanel.tsx)
  ("Delete errored runs," "Delete failed judge calls"), does the same.
- All four check against
  [DispatchAuthGuard](../../../backend/src/modules/dispatch/dispatch-auth.guard.ts),
  which only enforces in production and reads `body.password`.

This is clunky for the one person (the site owner) who ever legitimately
uses these features, and it does nothing to keep a casual viewer from even
*seeing* that these controls exist — the Activity page's operational
widgets and the entire Maintenance page are visible to everyone who loads
the site.

## Goals

- Log in once per device/browser; stay logged in for 90 days without
  re-entering a password.
- The four password-gated actions above (and any future admin action)
  authenticate via that session instead of a per-request password field.
- Non-admin visitors never see admin-only controls or admin-only data:
  the Activity page's operational row (token/judging/quota widgets, and the
  "Enable Auto-Dispatch" button) and the entire Maintenance page (nav link
  and route).
- Login lives behind a URL not linked from site navigation — `/admin-login`.

## Non-goals

- No multi-user accounts, roles, or permission levels. There is exactly one
  admin identity, gated by one shared secret (reusing `DISPATCH_PASSWORD`).
- No change to how the *puzzle-playing* experience works — this only
  touches the benchmark dashboard's operational/admin surface.
- Scripted/curl access to the guarded endpoints is preserved (see
  "Password fallback" below) but not made more convenient — this is a UI
  problem, not a scripting one.
- No CSRF-token-per-request scheme. `SameSite=Strict` plus a static custom
  header is judged sufficient for a single-admin, no-cross-site-need app.

## Architecture overview

A signed, `httpOnly` session cookie, following the pattern already used for
Bull Board's login in
[app.setup.ts](../../../backend/src/app.setup.ts) (`bullSessionSecret` /
`signBullSession` / `verifyBullSession`): an HMAC over an expiry timestamp,
keyed off a secret derived from `DISPATCH_PASSWORD`. No session store, no
new env var — changing `DISPATCH_PASSWORD` invalidates every outstanding
session, same as a password rotation should.

- Cookie name: `admin_session`. `httpOnly`, `secure` in production,
  `SameSite=Strict`, 90-day `maxAge`.
- `DispatchAuthGuard` becomes: valid cookie → pass. Else fall back to
  today's `body.password === DISPATCH_PASSWORD` check (scripting/curl
  stays working). Else 403. Every existing `@UseGuards(DispatchAuthGuard)`
  call site is unchanged.
- Outside production the guard still auto-passes, unchanged — so `isAdmin`
  is always `true` in local/dev, matching today's unrestricted dev
  behavior.
- CSRF: when a request authenticates via the cookie, the guard also
  requires header `X-Admin-Request: 1` (a plain non-empty marker, not a
  secret — cross-site requests can't set custom headers without triggering
  a CORS preflight the browser will block for an unlisted origin). This is
  defense-in-depth on top of `SameSite=Strict`; not required on the
  `body.password` fallback path.

## Backend changes

New `AuthModule` (`backend/src/modules/auth/`):

- `POST /auth/login` — body `{ password: string }`. Matches against
  `DISPATCH_PASSWORD` (same `timingSafeEqual` comparison
  `DispatchAuthGuard` already uses). On match, sets `admin_session` and
  returns `{ ok: true }`; otherwise 401.
- `POST /auth/logout` — clears the cookie.
- `GET /auth/me` — returns `{ isAdmin: boolean }`:
  `NODE_ENV !== "production"` or a valid `admin_session` cookie. The
  frontend calls this once at app load to decide what to render — it must
  agree exactly with what `DispatchAuthGuard` will actually allow, since
  it's the thing deciding whether to show the buttons that call the
  guarded routes.
- None of these three routes are themselves behind `DispatchAuthGuard`
  (login can't require what it grants; logout and `/me` are safe to call
  unauthenticated — logging out an already-logged-out session or asking
  "am I admin" are both no-ops for a non-admin).

`DispatchAuthGuard` (`backend/src/modules/dispatch/dispatch-auth.guard.ts`)
gains the cookie-check-first, password-fallback-second logic above, plus
the `X-Admin-Request` header check on the cookie path. Its constructor
already takes `ConfigService`; it additionally needs the request's raw
`Cookie` header, already available via `ExecutionContext`. Session
sign/verify logic (HMAC + timing-safe compare) is extracted into a small
shared helper (e.g. `backend/src/modules/auth/session.ts`) so
`AuthController` and `DispatchAuthGuard` share one implementation instead
of two.

No new env vars. No database changes.

## Frontend changes

- `AdminAuthContext` (new, mounted once near the app root in
  [App.tsx](../../../frontend/src/App.tsx) or
  [main.tsx](../../../frontend/src/main.tsx)): fetches `GET /auth/me` on
  mount, exposes `{ isAdmin, refresh, logout }`. Every fetch this app makes
  to a guarded endpoint switches to `credentials: "include"` plus the
  `X-Admin-Request: 1` header (added centrally in
  [data/benchmark/api.ts](../../../frontend/src/data/benchmark/api.ts),
  not per call site).
- New hidden route `/admin-login` in `App.tsx`, **not** added to
  [Header.tsx](../../../frontend/src/components/Header.tsx)'s nav — a
  simple password form that `POST`s to `/auth/login`, then calls
  `refresh()` and navigates to `/`.
- `Header.tsx`: the "Maintenance" `NavLink` renders only when `isAdmin`.
  A small "Log out" control renders only when `isAdmin` (visible only to
  the one visitor who's ever logged in — satisfies "casual viewer sees
  nothing" without needing a separate hidden-vs-shown mechanism).
- `MaintenancePage.tsx`: guards its content on `isAdmin` — a non-admin
  hitting `/maintenance` directly sees the same "not found" treatment the
  rest of the app uses for an unknown route, not the panel.
- `ActivityPage.tsx`: the `bench-free-tiers` row (both
  `FreeTierBudgetWidget`s, `CategoryJudgingWidget`, `GoogleDispatchWidget`)
  and the "Enable Auto-Dispatch" button render only when `isAdmin`.
  `RecentActivityTable` stays visible to everyone. Because the whole row is
  conditional, its data fetches (`fetchFreeTierUsage`,
  `fetchCategoryEvaluationCoverage`, dispatch-status polling) only fire for
  an admin session — no wasted requests for a viewer who can't see the
  result anyway.
- `FreeTierDispatchModal.tsx`, `DeleteRunModal.tsx`, `BulkActionModal.tsx`:
  drop the password field and the `password` parameter from the API calls
  they make (`startFreeTierDispatch`, `startBothFreeTierDispatch`,
  `deleteRun`, `deleteErroredRuns`, `deleteFailedJudgeCalls`) — auth now
  travels via the cookie + header, not the request body.
- Trigger buttons for the above (in `PuzzleRunsPage`/
  [GuessChainVisualizer.tsx](../../../frontend/src/components/benchmark/GuessChainVisualizer.tsx)
  for delete-run, `ActivityPage` for dispatch, `MaintenancePanel` for bulk
  cleanup) are already unreachable for a non-admin once their containing
  page/section is gated above — no separate gating needed on the buttons
  themselves.
- Session-expiry handling: a 401/403 from any admin-only call sets
  `isAdmin` to `false` in context and surfaces "Session expired — log in
  again" with a link to `/admin-login`, instead of the current generic
  "Invalid or missing dispatch password" message (which no longer makes
  sense once there's no password field to have gotten wrong).

## Error handling

- Wrong password at `/admin-login` → 401, form shows "Incorrect password."
- Expired/tampered cookie hitting a guarded route → falls through to the
  password-fallback check (fails, since the request body is a plain admin
  action call with no `password` field) → 403 → frontend's session-expiry
  handling above.
- `DISPATCH_PASSWORD` unset in production → `loadEnv()` already refuses to
  boot (existing behavior, unchanged) — login and the guard both inherit
  this "can't misconfigure into an open admin surface" property for free.

## Testing

- Backend: extend
  [dispatch-auth.guard.spec.ts](../../../backend/src/modules/dispatch/dispatch-auth.guard.spec.ts)
  with valid-cookie, expired-cookie, tampered-cookie, and
  password-fallback cases; new spec for `AuthController` (`/login` success
  and failure, `/logout` clears the cookie, `/me` reflects cookie state and
  dev bypass).
- Frontend: new `AdminAuthContext` test (mocked `/auth/me`); update
  [DeleteRunModal.test.tsx](../../../frontend/src/components/benchmark/__tests__/DeleteRunModal.test.tsx)
  and any `FreeTierDispatchModal`/`BulkActionModal` tests to drop
  password-field assertions; add tests asserting the Activity widget row,
  Maintenance nav link, and Maintenance page content are absent when
  `isAdmin` is `false` and present when `true`.

## Security note

This remains a single-shared-secret system, same trust model as today's
`DISPATCH_PASSWORD` — the session cookie changes *how often* that secret
must be typed, not who can know it or what they can do with it. Anyone who
learns the password can still mint themselves a session by visiting
`/admin-login`; hiding that URL from nav is obscurity, not access control,
and is treated as such (not a substitute for keeping the password secret).
