import { config } from "../config.js";
import { sql } from "../db.js";
import { getProvider } from "./providers/index.js";

/**
 * Risky actions pause the run and ask the user: "Tillåt en gång / Neka / Tillåt alltid".
 * Classification = keyword heuristics on the bot-declared intent (+ the action
 * itself), optionally double-checked by an independent "auto review" model.
 */

export const ACTION_TYPES = {
  send: "Skicka meddelanden & mejl",
  post: "Publicera & posta",
  purchase: "Köp, bokningar & betalningar",
  delete: "Radera",
  login: "Logga in, registrera & koppla konton",
  account: "Ändra konto- & säkerhetsinställningar",
  shell: "Riskabla terminalkommandon",
  routine: "Skapa & ändra routines",
  external: "Skrivande åtgärder i externa verktyg (MCP)",
} as const;
export type ActionType = keyof typeof ACTION_TYPES;

export interface Risk {
  actionType: ActionType;
  reason: string;
}

const RULES: [ActionType, RegExp][] = [
  ["purchase", /\b(köp|köpa|beställ|beställa|betala|betalning|buy|purchase|order|checkout|kassan?|pay|prenumerera|subscribe|boka|book|swish|klarna)\b/i],
  ["delete", /\b(radera|ta bort|delete|remove|trash|släng|töm|empty|avsluta konto|close account|unsubscribe)\b/i],
  ["send", /\b(skicka|sänd|send|reply|svara|forward|vidarebefordra|mejla|e-?mail|email|message|meddelande|dm|sms|invite|bjud in)\b/i],
  ["post", /\b(publicera|posta|post|tweet|tweeta|dela|share|publish|kommentera|comment|ladda upp|upload|recension|review)\b/i],
  ["login", /\b(logga in|login|log in|sign in|sign up|registrera|skapa konto|create account|authorize|auktorisera|godkänn app|connect account|oauth)\b/i],
  ["account", /\b(lösenord|password|säkerhetsinställning|2fa|two-factor|byt e-?post|change email|api.?key|token)\b/i],
];

const RISKY_SHELL =
  /(^|[;&|`\s(])(rm\s|rmdir|sudo|su\s|dd\s|mkfs|shutdown|reboot|kill(all)?\s|chmod\s+-R|chown\s+-R|git\s+push|npm\s+publish|ssh\s|scp\s|rsync\s.*:|mail\s|sendmail|curl\s.*(-X\s*(POST|PUT|DELETE|PATCH)|--data|-d\s|-F\s)|wget\s.*--post|crontab)/i;

export function classifyText(text: string): Risk | null {
  for (const [type, re] of RULES) {
    const m = text.match(re);
    if (m) return { actionType: type, reason: `"${m[0]}"` };
  }
  return null;
}

export function classifyShell(command: string): Risk | null {
  const m = command.match(RISKY_SHELL);
  if (m) return { actionType: "shell", reason: `"${m[0].trim()}"` };
  return classifyText(command)?.actionType === "send" ? { actionType: "send", reason: "kommandot verkar skicka något" } : null;
}

/** Optional independent review by a second model. Returns null when disabled or unsure. */
export async function autoReview(summary: string): Promise<Risk | null> {
  if (!config.autoReviewModel) return null;
  const [providerId, ...rest] = config.autoReviewModel.split(":");
  const model = rest.join(":");
  try {
    const provider = getProvider(providerId);
    const res = await provider.chat({
      model,
      system:
        "You review actions an AI agent is about to take on the user's computer. " +
        `Classify the action into exactly one of: ${Object.keys(ACTION_TYPES).join(", ")}, or "none" if it is harmless ` +
        "(reading, navigating, searching, filling a draft without submitting). Answer with JSON only: {\"type\": \"...\", \"reason\": \"...\"}.",
      messages: [{ role: "user", content: [{ type: "text", text: summary }] }],
      tools: [],
    });
    const json = JSON.parse(res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1));
    if (json.type && json.type !== "none" && json.type in ACTION_TYPES) {
      return { actionType: json.type, reason: `auto review: ${String(json.reason ?? "").slice(0, 200)}` };
    }
  } catch (err) {
    console.warn("[auto-review] failed", (err as Error).message);
  }
  return null;
}

export async function getPolicy(botId: string, actionType: string): Promise<"allow" | "deny" | null> {
  const [row] = await sql<{ decision: "allow" | "deny" }[]>`select decision from policies where bot_id = ${botId} and action_type = ${actionType}`;
  return row?.decision ?? null;
}

export async function setPolicy(botId: string, actionType: string, decision: "allow" | "deny" | null) {
  if (decision === null) await sql`delete from policies where bot_id = ${botId} and action_type = ${actionType}`;
  else
    await sql`insert into policies (bot_id, action_type, decision) values (${botId}, ${actionType}, ${decision})
      on conflict (bot_id, action_type) do update set decision = excluded.decision, updated_at = now()`;
}
