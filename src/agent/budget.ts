import type { Message } from "@earendil-works/pi-ai";

/**
 * The context budget the prompt promises: "道具的 SVG 源码默认不在你的上下文里" is a contract about
 * what stays in the director's head, and a long lesson breaks it. The tape and `<stage>` are the memory
 * in this design — the transcript is a window, and anything older than the window can be rebuilt from
 * the log (`fetch_prop`, the snapshot re-rendered every turn). So old turns get *deflated*, never dropped:
 * pairing between a tool call and its result, role order, and the record that a verb happened all stay
 * exactly where they were, and only the payload that nobody re-reads goes back to a pointer.
 *
 * Deflating rather than deleting is also what keeps the wire legal. Providers reject an assistant
 * tool-call without its result and vice versa, and Anthropic insists the most recent thinking blocks
 * ride along when tools are in play — so the newest `KEEP_RECENT` groups are never touched at all.
 */

/** One CJK character is about a token; Latin is about four per token. 2 is the honest middle and errs toward pruning early. */
export const CHARS_PER_TOKEN = 2;

/** Groups this close to the playhead keep every byte: thinking signatures, fresh artwork, the live tool pairing. */
export const KEEP_RECENT = 6;

/** A string this long is payload, not structure: it goes back to a pointer the model can re-fetch. */
export const HEAVY_STRING = 160;

export const DEFLATED = "（源码已按上下文预算裁剪 —— 东西还在带上，fetch_prop 读得回来）";

/** A turn's ceiling in characters: a slice of the context window left for output and the prompt itself. */
export function ceilingChars(contextWindow: number): number {
  return Math.max(8_000, Math.floor(contextWindow * 0.6 * CHARS_PER_TOKEN));
}

function textOf(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content as { type?: string; text?: string; thinking?: string; arguments?: unknown; content?: unknown }[]) {
    if (c?.type === "text") n += c.text?.length ?? 0;
    else if (c?.type === "thinking") n += c.thinking?.length ?? 0;
    else if (c?.type === "toolCall") n += JSON.stringify(c.arguments ?? {}).length;
    else if (Array.isArray(c?.content)) n += textOf(c.content);
  }
  return n;
}

/** How much of the wire this message costs, counted the same way the deflater pays it back. */
export function messageChars(m: Message): number {
  if (m.role === "toolResult") return textOf(m.content);
  if (m.role === "assistant") return textOf(m.content);
  if (m.role === "user") return textOf(m.content);
  const sections = (m as { sections?: Record<string, string | null> }).sections;
  return textOf(m.content) + (sections ? Object.values(sections).reduce((a, s) => a + (s?.length ?? 0), 0) : 0);
}

export function transcriptChars(messages: Message[]): number {
  return messages.reduce((a, m) => a + messageChars(m), 0);
}

/**
 * Long strings become a pointer, objects and arrays walk themselves. Keys short enough to be structure
 * (ids, labels, coordinates, mode names) survive untouched, so a deflated `build` still says which prop,
 * where, and that it was a `build` — the director loses the drawing, not the fact.
 */
export function deflate(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= HEAVY_STRING) return value;
    return `${value.slice(0, 60)}…（${value.length} 字符，已裁剪）`;
  }
  if (Array.isArray(value)) return value.map(deflate);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deflate(v);
    return out;
  }
  return value;
}

function deflateMessage(m: Message): Message {
  if (m.role === "assistant") {
    // A thinking block replayed from history is pure payload — the model already had the thought. It is
    // dropped whole rather than stubbed: its `thinkingSignature` is a provider-verified proof of that
    // exact text, so a stubbed body under a real signature is a wire error, not a saving.
    const kept = m.content.filter((c) => c.type !== "thinking");
    const content = (kept.length ? kept : m.content).map((c) => (c.type === "toolCall" ? { ...c, arguments: deflate(c.arguments) as never } : c));
    return { ...m, content };
  }
  if (m.role === "toolResult") {
    if (m.content.every((c) => c.type === "text" && c.text === DEFLATED)) return m;
    return { ...m, content: [{ type: "text", text: DEFLATED }] } as Message;
  }
  return m;
}

/** Where a group starts: an assistant message plus the tool results answering its calls. */
function isGroupStart(m: Message): boolean {
  return m.role === "assistant";
}

export interface Pruned {
  messages: Message[];
  /** Groups whose payload went back to a pointer this pass. */
  collapsed: number;
  chars: number;
}

/**
 * Bring the transcript under `ceiling` by deflating whole groups from the oldest forward, and stop at
 * the newest `keepRecent` ones. `collapsed` counts groups whose bytes actually changed — a group already
 * deflated is not reported again, so a caller can tell "nothing left to do" from "I just cut something",
 * which is the difference between a stable prefix and one that churns every turn.
 */
export function prune(messages: Message[], ceiling: number, keepRecent = KEEP_RECENT): Pruned {
  let chars = transcriptChars(messages);
  if (chars <= ceiling) return { messages, collapsed: 0, chars };
  // Group boundaries first, so we never split a call from its result.
  const starts: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (isGroupStart(messages[i])) starts.push(i);
  }
  const out = messages.slice();
  let collapsed = 0;
  for (let g = 0; g + keepRecent < starts.length; g++) {
    if (chars <= ceiling) break;
    const from = starts[g];
    const to = g + 1 < starts.length ? starts[g + 1] : messages.length;
    // The system head and the tail the caller asked to keep are both off-limits.
    let changed = false;
    for (let i = from; i < to; i++) {
      const before = messageChars(out[i]);
      out[i] = deflateMessage(out[i]);
      const after = messageChars(out[i]);
      if (after !== before) changed = true;
      chars += after - before;
    }
    if (changed) collapsed++;
  }
  // Nothing actually went smaller: hand the caller its own array back, byte for byte.
  if (collapsed === 0) return { messages, collapsed: 0, chars: transcriptChars(messages) };
  return { messages: out, collapsed, chars };
}
