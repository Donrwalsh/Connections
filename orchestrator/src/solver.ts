import {
  APICallError,
  JSONParseError,
  NoObjectGeneratedError,
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

  const details = parsed.error?.details;
  if (!Array.isArray(details)) return null;

  const quotaFailure = details.find(
    (d): d is GoogleQuotaFailureDetail =>
      typeof d === "object" && d !== null && (d as GoogleQuotaFailureDetail)["@type"]?.endsWith("QuotaFailure") === true,
  );
  const isPerMinute = quotaFailure?.violations?.some(
    (v) => v.quotaId?.includes("PerMinute") || v.quotaMetric?.includes("PerMinute"),
  );
  if (!isPerMinute) return null;

  const retryInfo = details.find(
    (d): d is GoogleRetryInfoDetail =>
      typeof d === "object" && d !== null && (d as GoogleRetryInfoDetail)["@type"]?.endsWith("RetryInfo") === true,
  );
  const seconds = retryInfo?.retryDelay ? parseFloat(retryInfo.retryDelay) : NaN;
  return Number.isFinite(seconds) ? seconds : undefined;
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
  }

  return new SolveError("model_error", `Model call failed: ${message}`, {
    ...details,
    ...apiDetails,
    errorName: err instanceof Error ? err.name : undefined,
  });
}
