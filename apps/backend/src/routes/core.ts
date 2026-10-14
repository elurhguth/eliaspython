import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.js";
import { config } from "../config.js";
import { json, sql } from "../db.js";
import { publish } from "../events.js";
import { listAllModels, defaultModel } from "../agent/providers/index.js";
import { ACTION_TYPES, setPolicy } from "../agent/policy.js";
import { dispatchUserMessage, getThread, insertMessage, publishRun, publishThread, threadBots, threadSummary } from "../crew.js";
import { enqueueRun, requestCancel } from "../queue.js";
import type { ApprovalRow, Block, BotRow } from "../types.js";
import { ws } from "../workstation.js";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

export function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "bot"
  );
}

function pickBot(body: any) {
  const out: Partial<BotRow> = {};
  for (const k of ["name", "role", "avatar", "color", "instructions", "provider", "model", "is_lead", "sort"] as const) {
    if (body[k] !== undefined) (out as any)[k] = body[k];
  }
  if (body.voice !== undefined) out.voice = body.voice;
  return out;
}

export function coreRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/auth/") || req.url.startsWith("/api/hooks/") || req.url === "/api/health") return;
    await requireUser(req, reply);
  });

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/bootstrap", async (req) => {
    const [bots, threads, approvals, models, workstation] = await Promise.all([
      sql<BotRow[]>`select * from bots order by sort, created_at`,
      sql`select t.*, coalesce((select array_agg(tb.bot_id) from thread_bots tb where tb.thread_id = t.id), '{}') as bot_ids,
            (select status from runs r where r.thread_id = t.id order by created_at desc limit 1) as last_run_status
          from threads t where not archived order by updated_at desc limit 100`,
      sql<ApprovalRow[]>`select * from approvals where status = 'pending' order by created_at`,
      listAllModels(),
      ws.health(),
    ]);
    return { user: req.user, bots, threads, approvals, models, workstation, actionTypes: ACTION_TYPES, defaultModel: defaultModel() };
  });

  app.get("/api/models", async (req) => listAllModels((req.query as any).refresh === "1"));

  // ---------------- Bots ----------------
  app.get("/api/bots", async () => sql`select * from bots order by sort, created_at`);

  app.post("/api/bots", async (req, reply) => {
    const body = req.body as any;
    if (!body?.name?.trim()) return reply.code(400).send({ error: "Namn krävs" });
    const dm = defaultModel();
    let slug = slugify(body.slug || body.name);
    const [taken] = await sql`select 1 from bots where slug = ${slug}`;
    if (taken) slug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;
    const b = { provider: dm.provider, model: dm.model, ...pickBot(body) };
    const [{ max }] = await sql<{ max: number | null }[]>`select max(sort) as max from bots`;
    const [bot] = await sql<BotRow[]>`
      insert into bots (name, slug, role, avatar, color, instructions, provider, model, is_lead, sort, voice)
      values (${b.name!.trim()}, ${slug}, ${b.role ?? ""}, ${b.avatar ?? "🤖"}, ${b.color ?? "#e8a25c"}, ${b.instructions ?? ""},
        ${b.provider}, ${b.model}, ${!!b.is_lead}, ${(max ?? 0) + 1}, ${json(b.voice ?? {})})
      returning *`;
    await publish({ type: "bots" });
    return bot;
  });

  app.patch("/api/bots/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const patch = pickBot(body);
    if (body.slug !== undefined) {
      const s = slugify(body.slug);
      if (!SLUG_RE.test(s)) return reply.code(400).send({ error: "Ogiltigt @namn" });
      const [taken] = await sql`select 1 from bots where slug = ${s} and id <> ${id}`;
      if (taken) return reply.code(409).send({ error: "@namnet används redan" });
      (patch as any).slug = s;
    }
    if (patch.is_lead) await sql`update bots set is_lead = false where id <> ${id}`;
    const keys = Object.keys(patch);
    if (!keys.length) return reply.code(400).send({ error: "Inget att uppdatera" });
    const values: Record<string, unknown> = { ...patch };
    if (values.voice !== undefined) values.voice = json(values.voice);
    const [bot] = await sql<BotRow[]>`update bots set ${sql(values as any, keys)}, updated_at = now() where id = ${id} returning *`;
    await publish({ type: "bots" });
    return bot;
  });

  app.delete("/api/bots/:id", async (req) => {
    const { id } = req.params as { id: string };
    await sql`delete from bots where id = ${id}`;
    await sql`delete from threads t where not exists (select 1 from thread_bots tb where tb.thread_id = t.id)`;
    await publish({ type: "bots" });
    return { ok: true };
  });

  // ---------------- Threads ----------------
  app.get("/api/threads", async (req) => {
    const q = req.query as { botId?: string; archived?: string; search?: string };
    return sql`select t.*, coalesce((select array_agg(tb.bot_id) from thread_bots tb where tb.thread_id = t.id), '{}') as bot_ids,
        (select status from runs r where r.thread_id = t.id order by created_at desc limit 1) as last_run_status
      from threads t
      where archived = ${q.archived === "1"}
        ${q.botId ? sql`and exists (select 1 from thread_bots tb where tb.thread_id = t.id and tb.bot_id = ${q.botId})` : sql``}
        ${q.search ? sql`and t.title ilike ${"%" + q.search + "%"}` : sql``}
      order by updated_at desc limit 200`;
  });

  app.post("/api/threads", async (req, reply) => {
    const { botIds, title } = req.body as { botIds: string[]; title?: string };
    if (!botIds?.length) return reply.code(400).send({ error: "Välj minst en bot" });
    const [t] = await sql<{ id: string }[]>`
      insert into threads (title, kind) values (${title ?? ""}, ${botIds.length > 1 ? "group" : "direct"}) returning id`;
    for (const b of botIds) await sql`insert into thread_bots (thread_id, bot_id) values (${t.id}, ${b}) on conflict do nothing`;
    await publishThread(t.id);
    return threadSummary(t.id);
  });

  app.get("/api/threads/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const thread = await threadSummary(id);
    if (!thread) return reply.code(404).send({ error: "not found" });
    const [messages, runs, approvals] = await Promise.all([
      sql`select * from (select * from messages where thread_id = ${id} order by seq desc limit 400) m order by seq`,
      sql`select * from runs where thread_id = ${id} order by created_at desc limit 60`,
      sql`select * from approvals where thread_id = ${id} order by created_at desc limit 100`,
    ]);
    const runIds = runs.map((r: any) => r.id);
    const steps = runIds.length
      ? await sql`select * from run_steps where run_id = any(${runIds}) order by created_at`
      : [];
    return { thread, messages, runs, steps, approvals };
  });

  app.patch("/api/threads/:id", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { title?: string; archived?: boolean; modelOverride?: { botId: string; provider: string; model: string } | null; addBotId?: string; removeBotId?: string };
    if (body.title !== undefined) await sql`update threads set title = ${body.title} where id = ${id}`;
    if (body.archived !== undefined) await sql`update threads set archived = ${body.archived} where id = ${id}`;
    if (body.modelOverride) {
      const { botId, provider, model } = body.modelOverride;
      await sql`update threads set model_override = coalesce(model_override, '{}'::jsonb) || ${json({ [botId]: { provider, model } })} where id = ${id}`;
    }
    if (body.addBotId) {
      await sql`insert into thread_bots (thread_id, bot_id) values (${id}, ${body.addBotId}) on conflict do nothing`;
      await sql`update threads set kind = 'group' where id = ${id} and kind = 'direct' and (select count(*) from thread_bots where thread_id = ${id}) > 1`;
    }
    if (body.removeBotId) {
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from thread_bots where thread_id = ${id}`;
      if (n > 1) await sql`delete from thread_bots where thread_id = ${id} and bot_id = ${body.removeBotId}`;
    }
    await publishThread(id);
    return threadSummary(id);
  });

  app.delete("/api/threads/:id", async (req) => {
    const { id } = req.params as { id: string };
    const runs = await sql<{ id: string }[]>`select id from runs where thread_id = ${id} and status in ('queued','running','waiting_approval','waiting_handoff')`;
    for (const r of runs) await requestCancel(r.id);
    await sql`delete from threads where id = ${id}`;
    await publish({ type: "thread", thread: { id, deleted: true } });
    return { ok: true };
  });

  // ---------------- Messages & uploads ----------------
  app.post("/api/threads/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text, attachmentIds } = req.body as { text?: string; attachmentIds?: string[] };
    const thread = await getThread(id);
    if (!thread) return reply.code(404).send({ error: "not found" });
    const content: Block[] = [];
    if (text?.trim()) content.push({ type: "text", text: text.trim() });
    if (attachmentIds?.length) {
      const atts = await sql<{ id: string; filename: string; mime: string; size: string; path: string }[]>`
        select * from attachments where id = any(${attachmentIds})`;
      for (const a of atts) {
        content.push({ type: "file", attachmentId: a.id, name: a.filename, path: a.path, mime: a.mime, size: Number(a.size) });
        if (a.mime.startsWith("image/") && Number(a.size) < 8 * 1024 * 1024) {
          content.push({ type: "image", ref: `uploads/${a.id}${path.extname(a.filename).toLowerCase() || ".img"}`, mime: a.mime, name: a.filename });
        }
      }
    }
    if (!content.length) return reply.code(400).send({ error: "Tomt meddelande" });
    if (!thread.title && text) {
      await sql`update threads set title = ${text.trim().replace(/\s+/g, " ").slice(0, 60)} where id = ${id}`;
    }
    const message = await insertMessage({ threadId: id, authorType: "user", role: "user", content });
    const runs = await dispatchUserMessage(id, text ?? "");
    await publishThread(id);
    return { message, runs };
  });

  app.post("/api/threads/:id/uploads", async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = await (req as any).file();
    if (!file) return reply.code(400).send({ error: "Ingen fil" });
    const buf: Buffer = await file.toBuffer();
    const safeName = String(file.filename || "fil").replace(/[^\w.\- ()åäöÅÄÖ]/g, "_").slice(0, 120);
    const day = new Date().toISOString().slice(0, 10);
    const wsPath = `uploads/${day}/${Date.now().toString(36)}-${safeName}`;
    const stored = await ws.upload(wsPath, buf);
    const attId = randomUUID();
    if (String(file.mimetype).startsWith("image/")) {
      const abs = path.join(config.dataDir, "uploads", `${attId}${path.extname(safeName).toLowerCase() || ".img"}`);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, buf);
    }
    const [att] = await sql`insert into attachments (id, thread_id, filename, mime, size, path)
      values (${attId}, ${id}, ${safeName}, ${file.mimetype || "application/octet-stream"}, ${buf.length}, ${stored.path}) returning *`;
    return att;
  });

  // Files in the data dir (screenshots, image uploads) – authenticated.
  app.get("/api/files/*", async (req, reply) => {
    const rel = (req.params as any)["*"] as string;
    const abs = path.resolve(config.dataDir, rel);
    const root = path.resolve(config.dataDir);
    if (!abs.startsWith(root + path.sep) || !/^(screenshots|uploads)\//.test(rel)) return reply.code(404).send();
    try {
      await fs.access(abs);
    } catch {
      return reply.code(404).send();
    }
    const ext = path.extname(abs).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
    reply.header("cache-control", "private, max-age=86400");
    return reply.type(type).send(createReadStream(abs));
  });

  // ---------------- Runs ----------------
  app.get("/api/runs", async (req) => {
    const q = req.query as { routineId?: string; status?: string; limit?: string };
    return sql`select r.*, b.name as bot_name, t.title as thread_title from runs r
      join bots b on b.id = r.bot_id join threads t on t.id = r.thread_id
      where true
        ${q.routineId ? sql`and r.routine_id = ${q.routineId}` : sql``}
        ${q.status === "active" ? sql`and r.status in ('queued','running','waiting_approval','waiting_handoff')` : sql``}
      order by r.created_at desc limit ${Math.min(Number(q.limit ?? 50), 200)}`;
  });

  app.post("/api/runs/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    await requestCancel(id);
    // Runs waiting for the user are not executing – close them directly.
    const [r] = await sql<{ status: string }[]>`select status from runs where id = ${id}`;
    if (r && ["queued", "waiting_approval", "waiting_handoff"].includes(r.status)) {
      await sql`update runs set status = 'cancelled', finished_at = now() where id = ${id}`;
      await sql`update approvals set status = 'denied', note = 'avbruten' where run_id = ${id} and status = 'pending'`;
      await sql`update run_steps set status = 'cancelled' where run_id = ${id} and status in ('running','waiting')`;
      const run = await publishRun(id);
      if (run) await publishThread(run.thread_id);
    }
    return { ok: true };
  });

  // ---------------- Approvals & handoff ----------------
  app.get("/api/approvals", async (req) => {
    const q = req.query as { status?: string };
    return q.status === "pending"
      ? sql`select * from approvals where status = 'pending' order by created_at`
      : sql`select a.*, b.name as bot_name from approvals a join bots b on b.id = a.bot_id order by a.created_at desc limit 200`;
  });

  app.post("/api/approvals/:id/decide", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { decision, note } = req.body as { decision: "allow_once" | "allow_always" | "deny"; note?: string };
    const [a] = await sql<ApprovalRow[]>`select * from approvals where id = ${id}`;
    if (!a) return reply.code(404).send({ error: "not found" });
    if (a.status !== "pending") return reply.code(409).send({ error: "Redan besvarad" });
    if (a.kind !== "approval") return reply.code(400).send({ error: "Fel typ" });
    const status = decision === "deny" ? "denied" : "allowed";
    const scope = decision === "allow_always" ? "always" : "once";
    const [updated] = await sql<ApprovalRow[]>`update approvals set status = ${status}, scope = ${scope}, note = ${note ?? null}, decided_at = now()
      where id = ${id} and status = 'pending' returning *`;
    if (!updated) return reply.code(409).send({ error: "Redan besvarad" });
    if (decision === "allow_always") await setPolicy(a.bot_id, a.action_type, "allow");
    await publish({ type: "approval", threadId: a.thread_id, approval: updated });
    await sql`update runs set status = 'queued' where id = ${a.run_id} and status = 'waiting_approval'`;
    await publishRun(a.run_id);
    await enqueueRun(a.run_id);
    return updated;
  });

  app.post("/api/approvals/:id/handoff", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { done, note } = req.body as { done: boolean; note?: string };
    const [updated] = await sql<ApprovalRow[]>`update approvals set status = ${done ? "done" : "denied"}, note = ${note ?? null}, decided_at = now()
      where id = ${id} and status = 'pending' and kind = 'handoff' returning *`;
    if (!updated) return reply.code(409).send({ error: "Redan besvarad" });
    await publish({ type: "approval", threadId: updated.thread_id, approval: updated });
    await sql`update runs set status = 'queued' where id = ${updated.run_id} and status = 'waiting_handoff'`;
    await publishRun(updated.run_id);
    await enqueueRun(updated.run_id);
    return updated;
  });

  app.get("/api/policies", async () => {
    const rows = await sql`select p.*, b.name as bot_name from policies p join bots b on b.id = p.bot_id order by b.sort, p.action_type`;
    return { policies: rows, actionTypes: ACTION_TYPES };
  });

  app.put("/api/policies", async (req, reply) => {
    const { botId, actionType, decision } = req.body as { botId: string; actionType: string; decision: "allow" | "deny" | null };
    if (!(actionType in ACTION_TYPES)) return reply.code(400).send({ error: "Okänd åtgärdstyp" });
    await setPolicy(botId, actionType, decision);
    return { ok: true };
  });

  // ---------------- Thread members helper ----------------
  app.get("/api/threads/:id/bots", async (req) => threadBots((req.params as any).id));
}
