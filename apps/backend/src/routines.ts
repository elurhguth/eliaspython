import { randomBytes } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { sql } from "./db.js";
import { publish } from "./events.js";
import { getRoutinesQueue } from "./queue.js";
import { addBotToThread, createRun, insertMessage, publishThread } from "./crew.js";

export interface RoutineRow {
  id: string;
  bot_id: string;
  name: string;
  prompt: string;
  cron: string | null;
  timezone: string;
  enabled: boolean;
  webhook_secret: string;
  thread_id: string | null;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

export function validateCron(cron: string, tz: string) {
  const it = CronExpressionParser.parse(cron, { tz });
  return it.next().toDate().toISOString();
}

export function nextRuns(cron: string, tz: string, n = 3) {
  try {
    const it = CronExpressionParser.parse(cron, { tz });
    return Array.from({ length: n }, () => it.next().toDate().toISOString());
  } catch {
    return [];
  }
}

export async function syncRoutineSchedule(r: RoutineRow) {
  const q = getRoutinesQueue();
  const id = `routine:${r.id}`;
  if (r.enabled && r.cron) {
    await q.upsertJobScheduler(id, { pattern: r.cron, tz: r.timezone }, { name: "routine", data: { routineId: r.id } });
  } else {
    await q.removeJobScheduler(id);
  }
}

export async function removeRoutineSchedule(routineId: string) {
  await getRoutinesQueue().removeJobScheduler(`routine:${routineId}`);
}

export async function createRoutine(input: { botId: string; name: string; prompt: string; cron: string | null; timezone?: string; enabled?: boolean }) {
  const tz = input.timezone || "Europe/Stockholm";
  if (input.cron) validateCron(input.cron, tz);
  const [r] = await sql<RoutineRow[]>`
    insert into routines (bot_id, name, prompt, cron, timezone, enabled, webhook_secret)
    values (${input.botId}, ${input.name}, ${input.prompt}, ${input.cron}, ${tz}, ${input.enabled ?? true}, ${randomBytes(18).toString("base64url")})
    returning *`;
  await syncRoutineSchedule(r);
  await publish({ type: "routine", routineId: r.id });
  return r;
}

/** Run a routine now: posts its prompt into the routine's own thread and starts the bot. */
export async function triggerRoutine(routineId: string, opts: { payload?: unknown; manual?: boolean } = {}) {
  const [r] = await sql<RoutineRow[]>`select * from routines where id = ${routineId}`;
  if (!r) throw new Error("routine not found");
  if (!opts.manual && !opts.payload && !r.enabled) return null;
  let threadId = r.thread_id;
  if (threadId) {
    const [exists] = await sql`select id from threads where id = ${threadId}`;
    if (!exists) threadId = null;
  }
  if (!threadId) {
    const [t] = await sql<{ id: string }[]>`insert into threads (title, kind, routine_id) values (${"⏰ " + r.name}, 'routine', ${r.id}) returning id`;
    threadId = t.id;
    await sql`update routines set thread_id = ${threadId} where id = ${r.id}`;
    await addBotToThread(threadId, r.bot_id);
  }
  let text = `⏰ Routine "${r.name}"${opts.manual ? " (startad manuellt)" : ""}:\n\n${r.prompt}`;
  if (opts.payload !== undefined) {
    const p = typeof opts.payload === "string" ? opts.payload : JSON.stringify(opts.payload, null, 2);
    text += `\n\nWebhook-data:\n\`\`\`\n${p.slice(0, 20_000)}\n\`\`\``;
  }
  await insertMessage({ threadId, authorType: "system", role: "user", content: [{ type: "text", text }] });
  await sql`update routines set last_run_at = now() where id = ${r.id}`;
  const run = await createRun({ threadId, botId: r.bot_id, trigger: opts.payload !== undefined ? "webhook" : "routine", routineId: r.id });
  await publishThread(threadId);
  await publish({ type: "routine", routineId: r.id });
  return run;
}
