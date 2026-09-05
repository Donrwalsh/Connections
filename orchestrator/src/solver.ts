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

  if (provider === "google" && APICallError.isInstance(err) && err.statusCode === 429) {
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
  }

  if (provider === "groq" && APICallError.isInstance(err) && err.statusCode === 429) {
    const headers = err.responseHeaders ?? {};
    const remainingRequests = headers["x-ratelimit-remaining-requests"];

    if (remainingRequests === "0") {
      const dailyResetSeconds =
        parseGroqResetDuration(headers["x-ratelimit-reset-requests"]) ??
        parseSecondsHeader(headers["retry-after"]);
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
  }

  return new SolveError("model_error", `Model call failed: ${message}`, {
    ...details,
    ...apiDetails,
    errorName: err instanceof Error ? err.name : undefined,
  });
}
