import { describe, expect, it } from "vitest";
import { formatAutomationLine } from "../automationFormat";
import type { AutomationLegDisplay } from "../../../data/benchmark/types";

const NEXT_RUN_AT = "2024-06-02T00:15:00.000Z";

function leg(overrides: Partial<AutomationLegDisplay> = {}): AutomationLegDisplay {
  return {
    message: null,
    lastRunAt: null,
    nextRunAt: NEXT_RUN_AT,
    isError: false,
    ...overrides,
  };
}

describe("formatAutomationLine", () => {
  it("says it hasn't run yet today when there's no last run", () => {
    expect(formatAutomationLine(leg())).toBe(
      "Auto-run: hasn't run yet today · Next: Jun 2, 2024, 12:15 AM",
    );
  });

  it("includes the message and timestamp when a run has happened", () => {
    expect(
      formatAutomationLine(
        leg({ message: "started at 80%", lastRunAt: "2024-06-01T00:15:00.000Z" }),
      ),
    ).toBe("Auto-run: started at 80% (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM");
  });

  it("still renders an error message the same way as any other message", () => {
    expect(
      formatAutomationLine(
        leg({ message: "failed: boom", lastRunAt: "2024-06-01T00:15:00.000Z", isError: true }),
      ),
    ).toBe("Auto-run: failed: boom (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM");
  });
});
