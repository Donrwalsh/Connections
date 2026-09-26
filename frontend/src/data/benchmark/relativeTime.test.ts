import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relativeTime";

describe("formatRelativeTime", () => {
  const base = new Date("2026-01-15T12:00:00.000Z").getTime();

  it("renders a sub-minute delta as 'now'", () => {
    expect(formatRelativeTime("2026-01-15T11:59:45.000Z", base)).toBe("now");
  });

  it("renders a 1 minute delta", () => {
    expect(formatRelativeTime("2026-01-15T11:59:00.000Z", base)).toBe("1m ago");
  });

  it("renders a 45 minute delta", () => {
    expect(formatRelativeTime("2026-01-15T11:15:00.000Z", base)).toBe("45m ago");
  });

  it("renders a 3 hour delta", () => {
    expect(formatRelativeTime("2026-01-15T09:00:00.000Z", base)).toBe("3h ago");
  });

  it("renders a 5 day delta", () => {
    expect(formatRelativeTime("2026-01-10T12:00:00.000Z", base)).toBe("5d ago");
  });

  it("keeps counting up for a multi-month delta instead of falling back to an absolute date", () => {
    expect(formatRelativeTime("2025-09-15T12:00:00.000Z", base)).toBe("4mo ago");
  });

  it("does not throw and returns a sane label for a future instant (clock skew)", () => {
    expect(() => formatRelativeTime("2026-01-15T12:05:00.000Z", base)).not.toThrow();
    expect(formatRelativeTime("2026-01-15T12:05:00.000Z", base)).toBe("in 5m");
  });
});
