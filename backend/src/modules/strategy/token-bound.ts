import type { ChatMessage } from "./orchestrator.service";

/**
 * A strict upper bound on a request's input tokens, computed before the call
 * so a free-tier-dispatched run can reserve the call's worst case (see
 * FreeTierBudgetService). Rests on one fact: a BPE token always covers at
 * least one byte, so a text's token count never exceeds its UTF-8 byte count.
 *
 * When an earlier call in this run reported its real promptTokens, that
 * exact figure stands in for the messages it covered (`known`), and only
 * what was added since is counted by bytes — keeping the bound within a few
 * hundred tokens of reality instead of ~4× over.
 */

// Role/framing tokens a chat API adds per message — generous on purpose.
export const PER_MESSAGE_OVERHEAD_TOKENS = 8;
// Request-level framing (priming tokens etc.) for a conversation counted
// entirely from bytes; a known prefix's real promptTokens already includes it.
export const REQUEST_OVERHEAD_TOKENS = 64;

/** The first `messageCount` messages of a conversation cost at most `tokens`. */
export interface KnownPrefix {
  messageCount: number;
  tokens: number;
}

export function inputTokenUpperBound(
  messages: readonly ChatMessage[],
  known: KnownPrefix | null,
): number {
  const usable = known !== null && known.messageCount <= messages.length ? known : null;
  let total = usable ? usable.tokens : REQUEST_OVERHEAD_TOKENS;
  for (let i = usable ? usable.messageCount : 0; i < messages.length; i++) {
    total += Buffer.byteLength(messages[i].content, "utf8") + PER_MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/** After a call whose request had `requestMessageCount` messages and reported
 * `promptTokens`, the conversation through the appended assistant reply is
 * bounded by that figure plus the reply's own bytes. The reply is bounded by
 * bytes rather than the call's completionTokens because the runner may echo
 * a compacted restatement instead of the raw reply (MULTIPLE_PROPOSALS). */
export function knownPrefixAfterReply(
  requestMessageCount: number,
  promptTokens: number,
  assistantContent: string,
): KnownPrefix {
  return {
    messageCount: requestMessageCount + 1,
    tokens:
      promptTokens + Buffer.byteLength(assistantContent, "utf8") + PER_MESSAGE_OVERHEAD_TOKENS,
  };
}
