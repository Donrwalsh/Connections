import { describe, expect, it } from "vitest";
import { buildAiAssistTurn } from "../aiAssistPrompts";

const REMAINING = [
  "HAIL",
  "RAIN",
  "SLEET",
  "SNOW",
  "BUCKS",
  "HEAT",
  "JAZZ",
  "NETS",
];

describe("buildAiAssistTurn", () => {
  it("builds the INITIAL prompt as a fresh single-message history", () => {
    const turn = buildAiAssistTurn({
      remainingItems: REMAINING,
      lockedInGroups: [],
      lastFailedGuess: null,
      history: [{ role: "assistant", content: "stale prior turn" }],
    });

    expect(turn.messages).toHaveLength(1);
    expect(turn.messages[0]).toEqual({ role: "user", content: turn.prompt });
    expect(turn.prompt).toContain(
      "You are playing NYT Connections. The items below form 2 groups of four",
    );
    expect(turn.prompt).toContain("Items: HAIL, RAIN, SLEET, SNOW, BUCKS, HEAT, JAZZ, NETS");
    expect(turn.prompt).toContain('a line containing only "ANSWER:"');
    expect(turn.prompt).toContain("exactly 2 lines, each with four comma-separated items");
    expect(turn.prompt).toContain("Output nothing after those lines.");
    expect(turn.prompt).toContain(
      "Use each item exactly once. Only use items from the list above — do not introduce new words.",
    );
  });

  it("appends the RETRY prompt onto the existing history", () => {
    const history = [
      { role: "user" as const, content: "INITIAL prompt" },
      { role: "assistant" as const, content: "First attempt" },
    ];

    const turn = buildAiAssistTurn({
      remainingItems: REMAINING,
      lockedInGroups: [],
      lastFailedGuess: {
        items: ["HAIL", "RAIN", "SLEET", "SNOW"],
        result: "incorrect",
      },
      history,
    });

    expect(turn.messages).toHaveLength(3);
    expect(turn.messages.slice(0, 2)).toEqual(history);
    expect(turn.messages[2]).toEqual({ role: "user", content: turn.prompt });
    expect(turn.prompt).toContain(
      "Feedback on your last guess: the group HAIL, RAIN, SLEET, SNOW was incorrect.",
    );
    expect(turn.prompt).toContain(
      'If the result is "incorrect": these four items are not all part of the same group.',
    );
    expect(turn.prompt).toContain(
      "Use each item exactly once. Only use items from the list above — do not introduce new words.",
    );
  });

  it("explains the one-away hint in the RETRY prompt", () => {
    const turn = buildAiAssistTurn({
      remainingItems: REMAINING,
      lockedInGroups: [],
      lastFailedGuess: {
        items: ["HAIL", "RAIN", "SLEET", "HEAT"],
        result: "oneAway",
      },
      history: [],
    });

    expect(turn.prompt).toContain(
      "Feedback on your last guess: the group HAIL, RAIN, SLEET, HEAT was oneAway.",
    );
    expect(turn.prompt).toContain(
      'If the result is "one away": three of these four items belong together in a group, but one of them does not.',
    );
  });

  it("lists confirmed correct groups in the RETRY prompt", () => {
    const turn = buildAiAssistTurn({
      remainingItems: ["BUCKS", "HEAT", "JAZZ", "NETS"],
      lockedInGroups: [["HAIL", "RAIN", "SLEET", "SNOW"]],
      lastFailedGuess: {
        items: ["BUCKS", "HEAT", "JAZZ", "HAIL"],
        result: "incorrect",
      },
      history: [],
    });

    expect(turn.prompt).toContain(
      "The following group(s) are already confirmed correct and should not be changed: [HAIL, RAIN, SLEET, SNOW].",
    );
    expect(turn.prompt).toContain(
      "The remaining items still to be grouped are: BUCKS, HEAT, JAZZ, NETS, forming 1 group(s) of four.",
    );
    expect(turn.prompt).toContain('output "ANSWER:" followed by 1 lines of four comma-separated items');
  });

  it("omits the confirmed-groups line when none are locked in", () => {
    const turn = buildAiAssistTurn({
      remainingItems: REMAINING,
      lockedInGroups: [],
      lastFailedGuess: {
        items: ["HAIL", "RAIN", "SLEET", "SNOW"],
        result: "incorrect",
      },
      history: [],
    });

    expect(turn.prompt).not.toContain("already confirmed correct");
  });
});
