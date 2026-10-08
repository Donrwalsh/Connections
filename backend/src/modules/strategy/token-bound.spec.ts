import {
  inputTokenUpperBound,
  knownPrefixAfterReply,
  PER_MESSAGE_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
} from "./token-bound";
import type { ChatMessage } from "./orchestrator.service";

const msg = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });

describe("inputTokenUpperBound", () => {
  it("bounds a conversation with no known usage by its UTF-8 byte count plus overhead", () => {
    const messages = [msg("user", "abcd"), msg("assistant", "ef"), msg("user", "g")];
    expect(inputTokenUpperBound(messages, null)).toBe(
      REQUEST_OVERHEAD_TOKENS + 4 + 2 + 1 + 3 * PER_MESSAGE_OVERHEAD_TOKENS,
    );
  });

  it("counts multi-byte characters by bytes, not characters", () => {
    // "é" is 2 bytes, "😀" is 4 bytes in UTF-8.
    expect(inputTokenUpperBound([msg("user", "é😀")], null)).toBe(
      REQUEST_OVERHEAD_TOKENS + 6 + PER_MESSAGE_OVERHEAD_TOKENS,
    );
  });

  it("starts from a known prefix and adds only the messages after it", () => {
    const messages = [msg("user", "x".repeat(5000)), msg("assistant", "yy"), msg("user", "zzz")];
    const known = { messageCount: 2, tokens: 1300 };
    expect(inputTokenUpperBound(messages, known)).toBe(1300 + 3 + PER_MESSAGE_OVERHEAD_TOKENS);
  });

  it("falls back to the full count when the known prefix is longer than the conversation", () => {
    const messages = [msg("user", "ab")];
    expect(inputTokenUpperBound(messages, { messageCount: 3, tokens: 10 })).toBe(
      REQUEST_OVERHEAD_TOKENS + 2 + PER_MESSAGE_OVERHEAD_TOKENS,
    );
  });
});

describe("knownPrefixAfterReply", () => {
  it("covers the request plus the assistant reply, bounding the reply by its bytes", () => {
    expect(knownPrefixAfterReply(1, 500, "ANSWER é")).toEqual({
      messageCount: 2,
      tokens: 500 + 9 + PER_MESSAGE_OVERHEAD_TOKENS,
    });
  });
});
