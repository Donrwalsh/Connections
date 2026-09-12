import {
  APICallError,
  JSONParseError,
  NoObjectGeneratedError,
  RetryError,
  TypeValidationError,
} from "ai";
import { type SolveErrorCode } from "./types.js";
import { type ModelProvider } from "./provider.js";

export interface SolveErrorDetails {
  prompt?: string;
  model?: string;
  contextWindow?: number;
  latencyMs?: number;
  temperature?: number;
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  statusCode?: number;
  errorName?: string;
  isRetryable?: boolean;
  // Seconds to wait before retrying — set only for a Google "rate_limited"
  // classification, from the response's own RetryInfo.retryDelay.
  retryAfterSeconds?: number;
  // Seconds until a Groq per-model daily (RPD) quota resets — set only for
  // a Groq "rate_limited_daily" classification, parsed from that response's
  // own x-ratelimit-reset-requests header (or its retry-after header as a
  // fallback). Groq's reset is a duration from the hit, not a fixed daily
  // clock boundary the way Google's Pacific-midnight reset is — see
  // GroqRateLimitHoldService on the backend, which uses this value directly
  // as `heldAt + dailyResetSeconds` rather than computing a shared boundary.
  dailyResetSeconds?: number;
}

/**
 * Typed failure from a solve step. `code` distinguishes recoverable bad
 * model output (duplicate/invalid groups) from unrecoverable model/network
 * failures, and (for Google) a per-minute rate limit that isn't a failure
 * at all, so the backend can react appropriately (re-prompt vs. wait vs.
 * abort).
 */
export class SolveError extends Error {
  constructor(
    readonly code: SolveErrorCode,
    message: string,
    readonly details: SolveErrorDetails = {},
  ) {
    super(message);
    this.name = "SolveError";
  }
}

/**
 * A Google Generative Language API 429 body follows Google Cloud's standard
 * google.rpc.Status error shape: `error.details[]` carries typed entries,
 * including (for a quota violation) a QuotaFailure with `violations[]` —
 * each violation's `quotaId` names the specific limit that was hit, e.g.
 * "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" — and (usually)
 * a sibling RetryInfo entry with a `retryDelay` like "3.857116819s". This
 * shape was confirmed live against a real key — see this feature's design
 * spec for the full captured example.
 */
interface GoogleQuotaFailureDetail {
  "@type": string;
  violations?: Array<{ quotaId?: string; quotaMetric?: string }>;
}

interface GoogleRetryInfoDetail {
  "@type": string;
  retryDelay?: string;
}

/**
 * Parses a Google 429 responseBody for a per-minute (RPM or TPM) quota
 * violation — the only case this repo treats as retryable rather than a
 * real failure (a per-day violation doesn't clear inside any reasonable
 * wait, so it's deliberately left to fall through to model_error). Returns
 * the seconds to wait (parsed from RetryInfo.retryDelay, e.g. "3.857116819s")
 * when a per-minute violation is found, `undefined` if one is found but no
 * RetryInfo accompanies it, or `null` when the body isn't a per-minute
 * violation at all (including: not JSON, no QuotaFailure, a per-day
 * violation, or any other shape this function doesn't recognize). Never
 * throws — an unparseable/unexpected body is just treated as "not a
 * per-minute hit", falling through to the existing model_error path.
 */
function parseGoogleRateLimit(responseBody: unknown): number | undefined | null {
  if (typeof responseBody !== "string") return null;

  let parsed: { error?: { details?: Array<GoogleQuotaFailureDetail | GoogleRetryInfoDetail> } };
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return null;
  }

  const details = parsed?.error?.details;
  if (!Array.isArray(details)) return null;

  const quotaFailure = details.find(
    (d): d is GoogleQuotaFailureDetail =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as GoogleQuotaFailureDetail)["@type"] === "string" &&
      (d as GoogleQuotaFailureDetail)["@type"].endsWith("QuotaFailure"),
  );
  const isPerMinute = quotaFailure?.violations?.some(
    (v) =>
      v != null &&
      typeof v === "object" &&
      ((typeof v.quotaId === "string" && v.quotaId.includes("PerMinute")) ||
        (typeof v.quotaMetric === "string" && v.quotaMetric.includes("PerMinute"))),
  );
  if (!isPerMinute) return null;

  const retryInfo = details.find(
    (d): d is GoogleRetryInfoDetail =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as GoogleRetryInfoDetail)["@type"] === "string" &&
      (d as GoogleRetryInfoDetail)["@type"].endsWith("RetryInfo"),
  );
  const seconds = retryInfo?.retryDelay ? parseFloat(retryInfo.retryDelay) : NaN;
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * True when a Google 429 responseBody carries a QuotaFailure whose violation
 * names a per-day quota ("PerDay" in the quotaId or quotaMetric). Uses the
 * same defensive parsing as parseGoogleRateLimit — never throws, returns
 * false for any shape it doesn't recognize (not JSON, no QuotaFailure, a
 * per-minute violation, etc). The daily reset time is not carried in the
 * body; the backend computes it as the next America/Los_Angeles midnight.
 */
function isGoogleDailyRateLimit(responseBody: unknown): boolean {
  if (typeof responseBody !== "string") return false;

  let parsed: { error?: { details?: Array<GoogleQuotaFailureDetail> } };
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return false;
  }

  const details = parsed?.error?.details;
  if (!Array.isArray(details)) return false;

  const quotaFailure = details.find(
    (d): d is GoogleQuotaFailureDetail =>
      typeof d === "object" &&
      d !== null &&
      typeof (d as GoogleQuotaFailureDetail)["@type"] === "string" &&
      (d as GoogleQuotaFailureDetail)["@type"].endsWith("QuotaFailure"),
  );

  return (
    quotaFailure?.violations?.some(
      (v) =>
        v != null &&
        typeof v === "object" &&
        ((typeof v.quotaId === "string" && v.quotaId.includes("PerDay")) ||
          (typeof v.quotaMetric === "string" && v.quotaMetric.includes("PerDay"))),
    ) ?? false
  );
}

/**
 * Parses an HTTP-style plain seconds count (e.g. Groq's `retry-after`
 * header, or a fallback read of the same value): a non-negative integer or
 * float string. Returns undefined for anything else (missing, negative,
 * non-numeric) rather than throwing.
 */
function parseSecondsHeader(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Parses a Groq-style rate-limit reset duration (e.g. "2h59m59.56s",
 * mirroring OpenAI's own rate-limit header format) into seconds. Every
 * component is optional but at least one must be present — an empty or
 * unrecognized string returns undefined rather than throwing or silently
 * treating garbage as a zero-second wait.
 */
function parseGroqResetDuration(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value.trim());
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
    return undefined;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

// A 429 whose reset window is more than this far out is OpenRouter's
// account-wide daily-quota hit (resets at UTC midnight); anything sooner is
// the fixed 20 req/min per-minute hit. Not configurable — this is a shape
// discriminator, not a tuning knob. See
// docs/superpowers/specs/2026-09-05-openrouter-free-tier-design.md §2.
const DAILY_RESET_THRESHOLD_SECONDS = 120;

/**
 * Parses OpenRouter's `X-RateLimit-Reset` header — a Unix-milliseconds
 * timestamp — into whole seconds from now (never negative). Returns
 * undefined for a missing, non-numeric, or non-finite value rather than
 * throwing. Confirm the ms-epoch interpretation against a real captured 429
 * before relying on it, per this repo's never-guess-a-response-shape policy.
 */
function parseResetTimestampSeconds(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const resetMs = Number(value);
  if (!Number.isFinite(resetMs)) return undefined;
  return Math.max(0, Math.ceil((resetMs - Date.now()) / 1000));
}

/**
 * Groq's 429 body message names the exact limit that tripped and its
 * window, e.g. "...on tokens per day (TPD): Limit 200000, Used 198984..."
 * or "...on requests per minute (RPM)...". A per-day limit (RPD or TPD)
 * does not clear inside any in-run wait — Groq's own "try again in 3m"
 * only frees a sliver of the daily bucket that the very next call
 * re-exhausts — so, like Google's PerDay path, it must park the run under
 * a per-model hold rather than be retried in place. Returns "tokens" or
 * "requests" for a per-day hit, or null for anything else (a per-minute
 * hit, or an absent/unrecognized message). Reads the structured
 * `error.message` from the JSON body when present, and also matches
 * against the raw body and the AI SDK's flattened error message. Never
 * throws.
 */
function groqPerDayRateLimitDimension(
  responseBody: unknown,
  fallbackMessage: string,
): "tokens" | "requests" | null {
  const texts = [fallbackMessage];
  if (typeof responseBody === "string") {
    texts.push(responseBody);
    try {
      const parsed = JSON.parse(responseBody) as { error?: { message?: unknown } };
      if (typeof parsed?.error?.message === "string") texts.push(parsed.error.message);
    } catch {
      // Not JSON — the raw string is already in `texts`.
    }
  }
  const text = texts.join("\n");
  if (!/\bper day\b/i.test(text) && !/\((?:RPD|TPD)\)/i.test(text)) return null;
  return /\btokens?\s+per\s+day\b/i.test(text) || /\(TPD\)/i.test(text) ? "tokens" : "requests";
}

/**
 * Mistral's La Plateforme free tier attaches no X-RateLimit-* headers, so a
 * transient per-minute (1 RPS / TPM) 429 and the month-long monthly-token-cap
 * wall look identical on the wire. Where the 429 body names a monthly / quota
 * exhaustion we can still tell them apart — mirroring
 * groqPerDayRateLimitDimension's body-message read (added in 0f37cc6). Returns
 * true only when the body clearly indicates the monthly/quota wall (which must
 * park the model, not be retried in place); false for a plain rate-limit
 * message or an absent/unreadable body — the runner's consecutive-429
 * heuristic is the fallback for a monthly wall the body failed to announce.
 * Never throws. The wording list is a best guess to be tuned against a real
 * captured Mistral monthly-cap 429.
 */
function mistralMonthlyRateLimitFromBody(
  responseBody: unknown,
  fallbackMessage: string,
): boolean {
  const texts = [fallbackMessage];
  if (typeof responseBody === "string") {
    texts.push(responseBody);
    try {
      const parsed = JSON.parse(responseBody) as {
        error?: { message?: unknown; type?: unknown; code?: unknown };
        message?: unknown;
        type?: unknown;
      };
      for (const v of [
        parsed?.error?.message,
        parsed?.error?.type,
        parsed?.error?.code,
        parsed?.message,
        parsed?.type,
      ]) {
        if (typeof v === "string") texts.push(v);
      }
    } catch {
      // Not JSON — the raw string is already in `texts`.
    }
  }
  const text = texts.join("\n");
  // Monthly / quota wording. Deliberately does NOT match a bare "rate limit"
  // (that is the per-minute case).
  return (
    /\bmonthly\b/i.test(text) ||
    /\bquota\b/i.test(text) ||
    /\bcapacity exceeded\b/i.test(text) ||
    /\bper month\b/i.test(text) ||
    /\bmonth(ly)?\s+(token|request)/i.test(text)
  );
}

/**
 * Turns a provider's 429 `APICallError` into a `rate_limited` /
 * `rate_limited_daily` `SolveError`, or `null` to fall through to
 * `model_error` when the response carries no usable rate-limit signal. One
 * entry per `ModelProvider` (the `Record` is total, so adding a provider is a
 * compile error until its 429 handling is decided); `null` means "this
 * provider has no special 429 handling" — openai and ollama.
 */
type RateLimit429Classifier = (
  err: APICallError,
  message: string,
  details: SolveErrorDetails,
  apiDetails: SolveErrorDetails,
) => SolveError | null;

const RATE_LIMIT_429_CLASSIFIERS: Record<ModelProvider, RateLimit429Classifier | null> = {
  openai: null,
  ollama: null,

  google: (err, message, details, apiDetails) => {
    const retryAfterSeconds = parseGoogleRateLimit(err.responseBody);
    if (retryAfterSeconds !== null) {
      return new SolveError("rate_limited", `Google rate limit hit: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
        retryAfterSeconds,
      });
    }
    if (isGoogleDailyRateLimit(err.responseBody)) {
      return new SolveError("rate_limited_daily", `Google daily quota exhausted: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
      });
    }
    return null;
  },

  groq: (err, message, details, apiDetails) => {
    const headers = err.responseHeaders ?? {};
    const remainingRequests = headers["x-ratelimit-remaining-requests"];
    const perDayDimension = groqPerDayRateLimitDimension(err.responseBody, message);

    if (remainingRequests === "0" || perDayDimension !== null) {
      // `x-ratelimit-reset-requests` counts down to the daily request reset
      // (hours out), so it's a sound proxy for when any per-day quota —
      // requests or tokens — clears. `retry-after` / `reset-tokens` on a
      // tokens-per-day hit only measure the seconds until a sliver of
      // today's token bucket trickles back, which would re-park the run
      // minutes later, so they're a fallback for a requests-per-day hit
      // only. A tokens-per-day hit with no `reset-requests` header carries
      // no dailyResetSeconds at all — the backend then holds the model for
      // LLM_GROQ_DAILY_HOLD_FALLBACK_SECONDS.
      const resetRequests = parseGroqResetDuration(headers["x-ratelimit-reset-requests"]);
      const dailyResetSeconds =
        perDayDimension === "tokens"
          ? resetRequests
          : (resetRequests ?? parseSecondsHeader(headers["retry-after"]));
      return new SolveError("rate_limited_daily", `Groq daily quota exhausted: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
        dailyResetSeconds,
      });
    }

    const retryAfterSeconds =
      parseSecondsHeader(headers["retry-after"]) ??
      parseGroqResetDuration(headers["x-ratelimit-reset-tokens"]);
    return new SolveError("rate_limited", `Groq rate limit hit: ${message}`, {
      ...details,
      ...apiDetails,
      errorName: err.name,
      retryAfterSeconds,
    });
  },

  openrouter: (err, message, details, apiDetails) => {
    const headers = err.responseHeaders ?? {};
    const resetSeconds = parseResetTimestampSeconds(headers["x-ratelimit-reset"]);
    const retryAfter = parseSecondsHeader(headers["retry-after"]);

    if (resetSeconds !== undefined || retryAfter !== undefined) {
      if (resetSeconds !== undefined && resetSeconds > DAILY_RESET_THRESHOLD_SECONDS) {
        return new SolveError("rate_limited_daily", `OpenRouter daily quota exhausted: ${message}`, {
          ...details,
          ...apiDetails,
          errorName: err.name,
          dailyResetSeconds: resetSeconds,
        });
      }
      return new SolveError("rate_limited", `OpenRouter rate limit hit: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
        retryAfterSeconds: retryAfter ?? resetSeconds,
      });
    }
    // No usable rate-limit signal — fall through to model_error, same as the
    // Groq branch does when its headers are absent.
    return null;
  },

  mistral: (err, message, details, apiDetails) => {
    if (mistralMonthlyRateLimitFromBody(err.responseBody, message)) {
      // Monthly / quota wall — park the model. dailyResetSeconds is left
      // unset (Mistral gives no reset countdown); the backend falls back to
      // MISTRAL_MODEL_HOLD_FALLBACK_SECONDS.
      return new SolveError("rate_limited_daily", `Mistral monthly quota exhausted: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
      });
    }
    const headers = err.responseHeaders ?? {};
    const retryAfterSeconds = parseSecondsHeader(headers["retry-after"]);
    // A bare 429 is unambiguously a rate limit even when nothing else about
    // it is legible — return rate_limited (not model_error). The runner's
    // consecutive-429 heuristic is the safety net for a monthly wall the
    // body did not announce.
    return new SolveError("rate_limited", `Mistral rate limit hit: ${message}`, {
      ...details,
      ...apiDetails,
      errorName: err.name,
      retryAfterSeconds,
    });
  },

  sambanova: (err, message, details, apiDetails) => {
    // SambaNova's free-tier caps are per-model (20 req/min, 20 req/day, 200K
    // tokens/day). Its 429 carries duration-style reset headers. Classify by
    // reset distance, like the OpenRouter branch: a long reset is the
    // per-model daily (requests or tokens) hit, a short one is the 20 RPM
    // hit. Header names/format confirmed against a real 429.
    const headers = err.responseHeaders ?? {};
    const dayResetSeconds = parseGroqResetDuration(headers["x-ratelimit-reset-requests-day"]);
    const minuteResetSeconds =
      parseGroqResetDuration(headers["x-ratelimit-reset-requests"]) ??
      parseSecondsHeader(headers["retry-after"]);
    const resetSeconds = dayResetSeconds ?? minuteResetSeconds;

    if (resetSeconds !== undefined) {
      if (resetSeconds > DAILY_RESET_THRESHOLD_SECONDS) {
        return new SolveError("rate_limited_daily", `SambaNova daily quota exhausted: ${message}`, {
          ...details,
          ...apiDetails,
          errorName: err.name,
          dailyResetSeconds: resetSeconds,
        });
      }
      return new SolveError("rate_limited", `SambaNova rate limit hit: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
        retryAfterSeconds: minuteResetSeconds ?? resetSeconds,
      });
    }
    // No usable rate-limit signal — fall through to model_error, same as the
    // Groq and OpenRouter branches do when their headers are absent.
    return null;
  },
};

/**
 * Classifies an AI SDK failure from generateObject/generateText into a typed
 * SolveError. Malformed-but-present output (no/undecodable object) is
 * recoverable — callers may re-prompt. Provider/network failures are not,
 * except a Google per-minute rate-limit hit, which classifies as
 * "rate_limited" rather than "model_error" — see parseGoogleRateLimit.
 *
 * When the failure is an APICallError (a real provider request that got a
 * non-2xx response, or a network-level failure the AI SDK wraps the same
 * way), its raw request/response detail — otherwise lost the moment this
 * function returns — rides along on the thrown SolveError's `details`, so
 * the backend can persist it for troubleshooting.
 */
export function classifyModelCallError(
  err: unknown,
  provider: ModelProvider,
  details: SolveErrorDetails,
): SolveError {
  // generateText/generateObject retry any retryable failure (every 429 is
  // retryable) up to maxRetries, then throw a RetryError wrapping the last
  // underlying error instead of that error itself. Classify against the
  // wrapped error, or a Google rate-limit hit is never recognised: it lands
  // on model_error, serialises as HTTP 502, and the runner retries it as a
  // generic model error rather than parking the run until quota resets.
  if (RetryError.isInstance(err) && err.lastError !== undefined) {
    return classifyModelCallError(err.lastError, provider, details);
  }

  const message = err instanceof Error ? err.message : "Unknown model error";

  if (
    err instanceof NoObjectGeneratedError ||
    err instanceof TypeValidationError ||
    err instanceof JSONParseError
  ) {
    return new SolveError(
      "invalid_group",
      `Model produced a malformed response: ${message}`,
      details,
    );
  }

  const apiDetails: SolveErrorDetails = APICallError.isInstance(err)
    ? {
        requestBody: err.requestBodyValues,
        statusCode: err.statusCode,
        responseHeaders: err.responseHeaders,
        responseBody: err.responseBody,
        isRetryable: err.isRetryable,
      }
    : {
        requestBody: undefined,
        statusCode: undefined,
      };

  if (APICallError.isInstance(err) && err.statusCode === 429) {
    const classified = RATE_LIMIT_429_CLASSIFIERS[provider]?.(
      err,
      message,
      details,
      apiDetails,
    );
    if (classified) return classified;
  }

  return new SolveError("model_error", `Model call failed: ${message}`, {
    ...details,
    ...apiDetails,
    errorName: err instanceof Error ? err.name : undefined,
  });
}
