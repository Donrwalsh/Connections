import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { classifyModelCallError, SolveError } from "./solver.js";

// The real 429 body captured from a live burst against Google AI Studio's
// gemini-3.6-flash — see the design spec for how this was obtained. A
// requests-per-minute violation: the quotaId contains "PerMinute".
const GOOGLE_RPM_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. " +
      "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
      "limit: 5, model: gemini-3.6-flash\nPlease retry in 3.857116819s.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.Help",
        links: [{ description: "Learn more", url: "https://ai.google.dev/gemini-api/docs/rate-limits" }],
      },
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            quotaDimensions: { location: "global", model: "gemini-3.6-flash" },
            quotaValue: "5",
          },
        ],
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3.857116819s" },
    ],
  },
});

// Synthesized per the documented behavioral split (Google's docs describe
// "quota_exceeded" as a distinct daily-limit reason from the per-minute
// "rate_limit_exceeded" case above) — not independently captured live, since
// reproducing a real daily-quota exhaustion isn't practical in a test.
const GOOGLE_RPD_BODY = JSON.stringify({
  error: {
    code: 429,
    message: "You exceeded your current quota... Quota exceeded for metric: ...requests, limit: 1500",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            quotaDimensions: { location: "global", model: "gemini-3.6-flash" },
            quotaValue: "1500",
          },
        ],
      },
    ],
  },
});

function makeAPICallError(overrides: {
  statusCode: number;
  responseBody?: string;
}): APICallError {
  return new APICallError({
    message: "Request failed",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    requestBodyValues: {},
    statusCode: overrides.statusCode,
    responseBody: overrides.responseBody,
    responseHeaders: {},
    isRetryable: overrides.statusCode === 429,
  });
}

describe("classifyModelCallError", () => {
  it("classifies a Google per-minute (RPM) hit as rate_limited with the server's retryDelay", () => {
    const err = makeAPICallError({ statusCode: 429, responseBody: GOOGLE_RPM_BODY });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result).toBeInstanceOf(SolveError);
    expect(result.code).toBe("rate_limited");
    expect(result.details.retryAfterSeconds).toBeCloseTo(3.857116819);
  });

  it("classifies a Google daily (RPD) hit as model_error, not rate_limited", () => {
    const err = makeAPICallError({ statusCode: 429, responseBody: GOOGLE_RPD_BODY });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result.code).toBe("model_error");
    expect(result.details.retryAfterSeconds).toBeUndefined();
  });

  it("falls back to model_error when the 429 body isn't JSON", () => {
    const err = makeAPICallError({ statusCode: 429, responseBody: "<html>rate limited</html>" });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result.code).toBe("model_error");
  });

  it("falls back to model_error when the 429 body has no QuotaFailure violation", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseBody: JSON.stringify({ error: { code: 429, message: "rate limited", details: [] } }),
    });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result.code).toBe("model_error");
  });

  it("falls back to model_error (not throw) when the details array contains a null entry", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseBody: JSON.stringify({
        error: { code: 429, message: "rate limited", details: [null, "not-an-object", 42] },
      }),
    });

    expect(() => classifyModelCallError(err, "google", { model: "gemini-3.6-flash" })).not.toThrow();

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });
    expect(result.code).toBe("model_error");
  });

  it("never classifies a non-google provider's 429 as rate_limited", () => {
    const err = makeAPICallError({ statusCode: 429, responseBody: GOOGLE_RPM_BODY });

    const result = classifyModelCallError(err, "openai", { model: "gpt-4.1-nano" });

    expect(result.code).toBe("model_error");
  });

  it("classifies a per-minute violation with no RetryInfo sibling as rate_limited with retryAfterSeconds undefined", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseBody: JSON.stringify({
        error: {
          code: 429,
          message: "rate limited",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [
                {
                  quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                  quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
                },
              ],
            },
          ],
        },
      }),
    });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result.code).toBe("rate_limited");
    expect(result.details.retryAfterSeconds).toBeUndefined();
  });

  it("still classifies a non-429 google error as model_error", () => {
    const err = makeAPICallError({ statusCode: 500, responseBody: "internal error" });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result.code).toBe("model_error");
  });
});
