import { mentionedBots, textOf } from "../crew.js";
import type { BotRow, MessageRow } from "../types.js";

/** Does this bot have something new to respond to? (tool results, a human message, or a teammate's @mention) */
export function needsResponse(messages: MessageRow[], bot: BotRow, team: BotRow[], seenSeq?: bigint) {
  return responseReason(messages, bot, team, seenSeq) !== null;
}

/**
 * `seenSeq` is the newest message the model saw on its last call. Messages that arrived while
 * the model was thinking get a lower seq than its reply, so they must be checked explicitly.
 */
export function responseReason(messages: MessageRow[], bot: BotRow, team: BotRow[], seenSeq?: bigint): "tool" | "human" | "mention" | null {
  let lastMine = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.author_type === "bot" && m.bot_id === bot.id && (m.role === "assistant" || m.role === "tool")) {
      lastMine = i;
      break;
    }
  }
  // Tool results always go back to the model.
  if (lastMine >= 0 && messages[lastMine].role === "tool") return "tool";
  const after = messages.filter((m, i) => i > lastMine || (seenSeq !== undefined && BigInt(m.seq) > seenSeq && !(m.author_type === "bot" && m.bot_id === bot.id)));
  if (after.some((m) => (m.author_type === "user" || m.author_type === "system") && m.role === "user")) return "human";
  const mentioned = after.some(
    (m) =>
      m.author_type === "bot" &&
      m.bot_id !== bot.id &&
      (m.role === "assistant" || m.role === "note") &&
      mentionedBots(textOf(m.content), team).some((b) => b.id === bot.id),
  );
  return mentioned ? "mention" : null;
}

