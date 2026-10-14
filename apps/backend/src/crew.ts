import { json, sql } from "./db.js";
import { publish } from "./events.js";
import { enqueueRun } from "./queue.js";
import { config } from "./config.js";
import { ACTIVE_STATUSES, type Block, type BotRow, type MessageRow, type RunRow, type ThreadRow } from "./types.js";

/** Shared data access + orchestration used by both the API server and the worker. */

export async function getBot(id: string) {
  const [b] = await sql<BotRow[]>`select * from bots where id = ${id}`;
  return b ?? null;
}

export async function getBots() {
  return sql<BotRow[]>`select * from bots order by sort, created_at`;
}

export async function getThread(id: string) {
  const [t] = await sql<ThreadRow[]>`select * from threads where id = ${id}`;
  return t ?? null;
}

export async function threadBots(threadId: string) {
  return sql<BotRow[]>`select b.* from bots b join thread_bots tb on tb.bot_id = b.id where tb.thread_id = ${threadId} order by b.sort, b.created_at`;
}

export async function getRun(id: string) {
  const [r] = await sql<RunRow[]>`select * from runs where id = ${id}`;
  return r ?? null;
}

export async function threadSummary(threadId: string) {
  const [t] = await sql`
    select t.*, coalesce((select array_agg(tb.bot_id) from thread_bots tb where tb.thread_id = t.id), '{}') as bot_ids,
      (select status from runs r where r.thread_id = t.id order by created_at desc limit 1) as last_run_status
    from threads t where t.id = ${threadId}`;
  return t ?? null;
}

export async function publishThread(threadId: string) {
  const t = await threadSummary(threadId);
  if (t) await publish({ type: "thread", thread: t });
}

export async function insertMessage(m: {
  threadId: string;
  authorType: MessageRow["author_type"];
  botId?: string | null;
  runId?: string | null;
  role: MessageRow["role"];
  content: Block[];
  raw?: unknown;
}) {
  const [row] = await sql<MessageRow[]>`
    insert into messages (thread_id, author_type, bot_id, run_id, role, content, raw)
    values (${m.threadId}, ${m.authorType}, ${m.botId ?? null}, ${m.runId ?? null}, ${m.role}, ${json(m.content)}, ${m.raw ? json(m.raw) : null})
    returning *`;
  await sql`update threads set updated_at = now() where id = ${m.threadId}`;
  await publish({ type: "message", threadId: m.threadId, message: row });
  return row;
}

export async function publishRun(runId: string) {
  const run = await getRun(runId);
  if (run) await publish({ type: "run", threadId: run.thread_id, run });
  return run;
}

export async function createRun(r: {
  threadId: string;
  botId: string;
  trigger: RunRow["trigger"];
  routineId?: string | null;
  parentRunId?: string | null;
  depth?: number;
}) {
  const [run] = await sql<RunRow[]>`
    insert into runs (thread_id, bot_id, trigger, routine_id, parent_run_id, depth)
    values (${r.threadId}, ${r.botId}, ${r.trigger}, ${r.routineId ?? null}, ${r.parentRunId ?? null}, ${r.depth ?? 0})
    returning *`;
  await publish({ type: "run", threadId: r.threadId, run });
  await enqueueRun(run.id);
  return run;
}

/** Start a run for (thread, bot) unless one is already active – an active run picks up new messages by itself. */
export async function ensureRun(r: Parameters<typeof createRun>[0]) {
  const [active] = await sql<RunRow[]>`
    select * from runs where thread_id = ${r.threadId} and bot_id = ${r.botId} and status = any(${ACTIVE_STATUSES})
    order by created_at desc limit 1`;
  if (active) return active;
  return createRun(r);
}

export function textOf(content: Block[]) {
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

/** @mentions (by slug or name) that match bots. */
export function mentionedBots(text: string, bots: BotRow[]) {
  const lower = text.toLowerCase();
  return bots.filter((b) => {
    const handles = [b.slug.toLowerCase(), b.name.toLowerCase().replace(/\s+/g, "")];
    return handles.some((h) => new RegExp(`(^|[^\\w])@${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(lower));
  });
}

export async function addBotToThread(threadId: string, botId: string) {
  const res = await sql`insert into thread_bots (thread_id, bot_id) values (${threadId}, ${botId}) on conflict do nothing`;
  if (res.count > 0) {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from thread_bots where thread_id = ${threadId}`;
    if (n > 1) await sql`update threads set kind = 'group' where id = ${threadId} and kind = 'direct'`;
    await publishThread(threadId);
  }
}

/** Decide which bots answer a new human message. */
export async function dispatchUserMessage(threadId: string, text: string) {
  const thread = await getThread(threadId);
  if (!thread) throw new Error("thread not found");
  const all = await getBots();
  let members = await threadBots(threadId);
  const mentioned = mentionedBots(text, all);
  for (const b of mentioned) {
    if (!members.some((m) => m.id === b.id)) {
      await addBotToThread(threadId, b.id);
      members = await threadBots(threadId);
    }
  }
  let responders = mentioned.filter((b) => members.some((m) => m.id === b.id));
  if (!responders.length) {
    if (members.length === 1) responders = members;
    else responders = [members.find((m) => m.is_lead) ?? members[0]].filter(Boolean);
  }
  const runs = [];
  for (const bot of responders) runs.push(await ensureRun({ threadId, botId: bot.id, trigger: "chat" }));
  return runs;
}

/** After a bot finishes: wake up teammates it @mentioned (bounded chain depth). */
export async function dispatchMentions(run: RunRow, text: string) {
  if (!text || run.depth >= config.maxBotChainDepth) return;
  const all = await getBots();
  const targets = mentionedBots(text, all).filter((b) => b.id !== run.bot_id);
  for (const bot of targets) {
    await addBotToThread(run.thread_id, bot.id);
    await ensureRun({ threadId: run.thread_id, botId: bot.id, trigger: "delegation", parentRunId: run.id, depth: run.depth + 1 });
  }
}

export async function audit(e: {
  botId?: string | null;
  runId?: string | null;
  threadId?: string | null;
  tool: string;
  actionType?: string | null;
  params?: unknown;
  outcome: string;
  detail?: string | null;
}) {
  const { redact } = await import("./redact.js");
  await sql`insert into audit_log (bot_id, run_id, thread_id, tool, action_type, params, outcome, detail)
    values (${e.botId ?? null}, ${e.runId ?? null}, ${e.threadId ?? null}, ${e.tool}, ${e.actionType ?? null},
      ${json(redact(e.params ?? {}))}, ${e.outcome}, ${e.detail ? redact(e.detail).slice(0, 2000) : null})`;
}
