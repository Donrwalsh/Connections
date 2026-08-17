import type { AiChatMessage, GuessResult } from "./gameReducer";

/**
 * Context needed to build the next AI Assist prompt. `lockedInGroups` and
 * `remainingItems` mirror the game's solved groups and remaining words — they
 * are passed explicitly so the prompt builders stay pure and testable.
 */
export interface AiAssistTurnContext {
  remainingItems: string[];
  lockedInGroups: string[][];
  lastFailedGuess: { items: string[]; result: GuessResult } | null;
  history: AiChatMessage[];
}

export interface AiAssistTurn {
  prompt: string;
  messages: AiChatMessage[];
}

/**
 * Builds the next user prompt for the AI Assist session and the full message
 * history to submit with it.
 *
 * Two-mode flow:
 *   - When there is no last failed guess, the session restarts: the INITIAL
 *     prompt is sent as a fresh, single-user-message history (no prior
 *     context).
 *   - When the last guess failed, the RETRY prompt is appended onto the
 *     existing history (which holds the prior prompts and the model's prior
 *     responses) and the whole history is re-submitted.
 */
export function buildAiAssistTurn(context: AiAssistTurnContext): AiAssistTurn {
  const N = context.remainingItems.length / 4;
  const prompt = context.lastFailedGuess
    ? buildRetryPrompt(
        context.remainingItems,
        context.lockedInGroups,
        context.lastFailedGuess,
        N,
      )
    : buildInitialPrompt(context.remainingItems, N);
  const messages: AiChatMessage[] = context.lastFailedGuess
    ? [...context.history, { role: "user", content: prompt }]
    : [{ role: "user", content: prompt }];
  return { prompt, messages };
}

function buildInitialPrompt(items: string[], N: number): string {
  return [
    `You are playing NYT Connections. The items below form ${N} groups of four, where each group shares something in common. Propose your best guess for all ${N} groups.`,
    "",
    `Items: ${items.join(", ")}`,
    "",
    `For each of your ${N} proposed groups, briefly explain (1-2 sentences) why you believe those four items belong together. Then output a line containing only "ANSWER:", followed by exactly ${N} lines, each with four comma-separated items — one line per group. Output nothing after those lines.`,
    "",
    "Use each item exactly once. Only use items from the list above — do not introduce new words.",
  ].join("\n");
}

function buildRetryPrompt(
  remainingItems: string[],
  lockedInGroups: string[][],
  lastFailedGuess: NonNullable<AiAssistTurnContext["lastFailedGuess"]>,
  N: number,
): string {
  const parts = [
    `Feedback on your last guess: the group ${lastFailedGuess.items.join(", ")} was ${lastFailedGuess.result}.`,
    "",
    '- If the result is "incorrect": these four items are not all part of the same group.',
    '- If the result is "one away": three of these four items belong together in a group, but one of them does not.',
  ];

  if (lockedInGroups.length > 0) {
    parts.push(
      "",
      `The following group(s) are already confirmed correct and should not be changed: ${lockedInGroups
        .map((group) => `[${group.join(", ")}]`)
        .join(", ")}.`,
    );
  }

  parts.push(
    "",
    `The remaining items still to be grouped are: ${remainingItems.join(", ")}, forming ${N} group(s) of four.`,
    "",
    `Considering this feedback, propose your best guess for all ${N} remaining groups. As before, briefly explain your reasoning for each, then output "ANSWER:" followed by ${N} lines of four comma-separated items.`,
    "",
    "Use each item exactly once. Only use items from the list above — do not introduce new words.",
  );

  return parts.join("\n");
}
