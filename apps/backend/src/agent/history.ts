import { sql } from "../db.js";
import type { Block, BotRow, MessageRow } from "../types.js";
import type { LlmMessage } from "./providers/types.js";

/**
 * Build the conversation as one particular bot should see it.
 *  - Its own assistant/tool messages are kept verbatim (incl. raw provider content).
 *  - The human's messages are user turns.
 *  - Other bots' visible replies and notes become user turns prefixed "[Name]: …".
 *  - Other bots' tool traffic is hidden.
 * Messages from others that arrive while this bot has outstanding tool calls are
 * deferred until after its tool results, so tool_call/tool_result pairs stay adjacent.
 */

const KEEP_IMAGES = 3;
const MAX_CHARS = 600_000;

function label(m: MessageRow, botsById: Map<string, BotRow>) {
  if (m.author_type === "user") return "Användaren";
  if (m.author_type === "system") return "System";
  return botsById.get(m.bot_id ?? "")?.name ?? "Bot";
}

function prefixText(content: Block[], prefix: string): Block[] {
  const out: Block[] = [];
  let done = false;
  for (const b of content) {
    if (b.type === "text" && !done) {
      out.push({ type: "text", text: `${prefix}${b.text}` });
      done = true;
    } else if (b.type === "text" || b.type === "image" || b.type === "file") out.push(b);
  }
  if (!done) out.unshift({ type: "text", text: prefix.trim() });
  return out;
}

export async function loadThreadMessages(threadId: string) {
  return sql<MessageRow[]>`select * from messages where thread_id = ${threadId} order by seq`;
}

export function buildHistory(messages: MessageRow[], bot: BotRow, botsById: Map<string, BotRow>, isGroup: boolean): LlmMessage[] {
  const out: LlmMessage[] = [];
  let pending = new Set<string>();
  let deferred: LlmMessage[] = [];

  const emitOther = (m: LlmMessage) => (pending.size ? deferred.push(m) : out.push(m));

  for (const m of messages) {
    const mine = m.author_type === "bot" && m.bot_id === bot.id;
    if (mine && m.role === "assistant") {
      out.push({ role: "assistant", content: m.content, raw: m.raw });
      const calls = m.content.filter((b) => b.type === "tool_call") as Extract<Block, { type: "tool_call" }>[];
      pending = new Set(calls.map((c) => c.id));
      continue;
    }
    if (mine && m.role === "tool") {
      out.push({ role: "tool", content: m.content });
      for (const b of m.content) if (b.type === "tool_result") pending.delete(b.toolCallId);
      if (!pending.size && deferred.length) {
        out.push(...deferred);
        deferred = [];
      }
      continue;
    }
    if (mine && m.role === "note") continue; // the bot already knows what it posted (tool result)
    if (m.role === "tool" || (m.role === "assistant" && m.author_type === "bot" && !m.content.some((b) => b.type === "text" && b.text.trim())))
      continue; // other bots' tool traffic

    if (m.author_type === "user" && m.role === "user") {
      emitOther({ role: "user", content: isGroup ? prefixText(m.content, "[Användaren]: ") : m.content });
    } else {
      const visible = m.content.filter((b) => b.type === "text" || b.type === "image" || b.type === "file");
      if (!visible.length) continue;
      emitOther({ role: "user", content: prefixText(visible, `[${label(m, botsById)}]: `) });
    }
  }

  // Outstanding tool calls (crashed mid-run or still pending) – the loop handles the
  // newest one; older ones get synthetic results so the transcript stays valid.
  if (pending.size) {
    const lastAssistant = [...out].reverse().find((x) => x.role === "assistant");
    const lastCalls = new Set(
      (lastAssistant?.content.filter((b) => b.type === "tool_call") as Extract<Block, { type: "tool_call" }>[] | undefined)?.map((c) => c.id) ?? [],
    );
    const orphan = [...pending].filter((id) => !lastCalls.has(id));
    if (orphan.length) {
      // Should not happen with the loop's invariants; keep the API happy anyway.
      out.push({ role: "tool", content: orphan.map((id) => ({ type: "tool_result", toolCallId: id, name: "", content: "(avbröts)", isError: true })) });
    }
    out.push(...deferred);
  }

  repairPairs(out);
  pruneImages(out);
  return truncate(out);
}

/** Every assistant tool_call needs a result in the following tool turn (except a trailing one). */
function repairPairs(msgs: LlmMessage[]) {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "assistant") continue;
    const calls = m.content.filter((b) => b.type === "tool_call") as Extract<Block, { type: "tool_call" }>[];
    if (!calls.length) continue;
    const next = msgs[i + 1];
    if (!next) continue; // pending – handled by the loop
    const have = new Set(next.role === "tool" ? next.content.filter((b) => b.type === "tool_result").map((b) => (b as any).toolCallId) : []);
    const missing = calls.filter((c) => !have.has(c.id));
    if (!missing.length) continue;
    const synthetic: Block[] = missing.map((c) => ({ type: "tool_result", toolCallId: c.id, name: c.name, content: "(avbröts – inget resultat)", isError: true }));
    if (next.role === "tool") next.content = [...next.content, ...synthetic];
    else msgs.splice(i + 1, 0, { role: "tool", content: synthetic });
  }
}

function pruneImages(msgs: LlmMessage[]) {
  let kept = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "tool") continue;
    m.content = m.content.map((b) => {
      if (b.type === "tool_result" && b.image) {
        if (kept < KEEP_IMAGES) {
          kept++;
          return b;
        }
        return { ...b, image: undefined, content: b.content + "\n(äldre skärmdump borttagen för att spara plats)" };
      }
      return b;
    });
  }
}

function size(m: LlmMessage) {
  return m.content.reduce((n, b) => n + (b.type === "text" ? b.text.length : b.type === "tool_result" ? b.content.length : b.type === "tool_call" ? JSON.stringify(b.input).length : 200), 0);
}

/** Drop the oldest turns when the transcript gets huge, cutting at a user turn boundary. */
function truncate(msgs: LlmMessage[]): LlmMessage[] {
  let total = msgs.reduce((n, m) => n + size(m), 0);
  if (total <= MAX_CHARS) return msgs;
  let start = 0;
  while (total > MAX_CHARS && start < msgs.length - 2) {
    total -= size(msgs[start]);
    start++;
  }
  while (start < msgs.length && msgs[start].role !== "user") start++;
  const kept = msgs.slice(start);
  kept.unshift({ role: "user", content: [{ type: "text", text: "[System]: Äldre delar av konversationen har kortats bort. Använd search_history vid behov." }] });
  return kept;
}
