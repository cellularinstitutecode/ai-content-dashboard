// Structurally identical to lib/ai.ts's ToolMessage. Declared locally so this
// module stays dependency-free and testable without the module graph behind it.
export type ToolMessage = { role: 'user' | 'assistant'; content: any };

// The tool transcript round-trips through the browser, so its size and shape are
// caller-controlled. `chatWithTools` forwards it to Anthropic verbatim - unlike
// `chatAssistant`, which trims - so an oversized transcript drove up to four
// sequential model calls per request on whatever the caller sent.
//
// Trimming this list is not as simple as slicing it. The transcript is a strict
// alternation: a plain-text user message, then pairs of assistant(tool_use) /
// user(tool_result), then the assistant's final text. Cutting at an arbitrary
// index can leave a tool_result whose matching tool_use was cut away, and
// Anthropic rejects that with a 400 - which would throw out of runAgent before
// the trimmed list is stored, so the SAME window would be re-sent next turn.
// The assistant would degrade into a plain chatbot for the rest of the session
// and only a page reload would recover it.
//
// So: cut only at turn boundaries, and never drop half of a pair. Oversized
// content is truncated in place rather than removed, for the same reason.
const MAX_TOOL_MESSAGES = 24;
const MAX_TOOL_MESSAGE_CHARS = 8000;

type ToolBlock = { type?: string; content?: unknown; [k: string]: unknown };

// A turn starts at a plain-text user message. Anything else (a tool_result, or
// any assistant message) is mid-turn and unsafe to cut in front of.
function isTurnStart(m: unknown): boolean {
  if (!m || typeof m !== "object") return false;
  const { role, content } = m as { role?: unknown; content?: unknown };
  return role === "user" && typeof content === "string";
}

// Shrink a message without changing its shape: strings are sliced, tool_result
// blocks keep their tool_use_id and lose only their text.
function truncateMessage(m: ToolMessage): ToolMessage {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.length > MAX_TOOL_MESSAGE_CHARS
      ? ({ ...m, content: content.slice(0, MAX_TOOL_MESSAGE_CHARS) } as ToolMessage)
      : m;
  }
  if (!Array.isArray(content)) return m;
  const blocks = (content as ToolBlock[]).map((b) => {
    if (!b || typeof b !== "object") return b;
    if (typeof b.content === "string" && b.content.length > MAX_TOOL_MESSAGE_CHARS) {
      return { ...b, content: b.content.slice(0, MAX_TOOL_MESSAGE_CHARS) + "\n[truncated]" };
    }
    if (typeof b.text === "string" && (b.text as string).length > MAX_TOOL_MESSAGE_CHARS) {
      return { ...b, text: (b.text as string).slice(0, MAX_TOOL_MESSAGE_CHARS) + "\n[truncated]" };
    }
    return b;
  });
  return { ...m, content: blocks } as ToolMessage;
}

export function boundToolMessages(raw: unknown): ToolMessage[] {
  if (!Array.isArray(raw)) return [];

  const valid = raw.filter((m) => {
    if (!m || typeof m !== "object") return false;
    const role = (m as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") return false;
    const content = (m as { content?: unknown }).content;
    return typeof content === "string" || Array.isArray(content);
  }) as ToolMessage[];

  if (valid.length <= MAX_TOOL_MESSAGES) return valid.map(truncateMessage);

  // Keep the most recent whole turns that fit. Walking the turn starts from the
  // end and taking the earliest one still inside the budget keeps as much
  // context as possible without ever splitting a tool_use/tool_result pair.
  let cut = valid.length;
  for (let i = valid.length - 1; i >= 0; i--) {
    if (!isTurnStart(valid[i])) continue;
    if (valid.length - i > MAX_TOOL_MESSAGES) break;
    cut = i;
  }
  // No turn boundary fits (one enormous turn): start the transcript over rather
  // than send a malformed one. An empty transcript is always valid.
  if (cut >= valid.length) return [];
  return valid.slice(cut).map(truncateMessage);
}
