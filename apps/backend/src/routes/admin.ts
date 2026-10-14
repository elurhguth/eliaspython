import { timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { getSetting, json, setSetting, sql } from "../db.js";
import { subscribe, type CrewEvent } from "../events.js";
import { deleteMemory, listMemory, listSkills, memoryHistory, readMemory, revertMemoryEvent, writeMemory } from "../memory.js";
import { notify, removeSubscription, saveSubscription, vapidKeys } from "../push.js";
import { createRoutine, nextRuns, removeRoutineSchedule, syncRoutineSchedule, triggerRoutine, validateCron, type RoutineRow } from "../routines.js";
import { listServerTools, resetServer, type McpServerRow } from "../agent/mcp.js";
import { ws } from "../workstation.js";

const bus = new EventEmitter();
bus.setMaxListeners(1000);
let subscribed = false;

export function adminRoutes(app: FastifyInstance) {
  // ---------------- Live events (SSE) ----------------
  app.get("/api/events", async (req, reply) => {
    if (!subscribed) {
      subscribe((e) => bus.emit("event", e));
      subscribed = true;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`retry: 3000\n\n`);
    const onEvent = (e: CrewEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    bus.on("event", onEvent);
    const ping = setInterval(() => res.write(`: ping\n\n`), 20_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      bus.off("event", onEvent);
    });
  });

  // ---------------- Memory ----------------
  app.get("/api/memory", async () => ({
    files: await listMemory({ includeAllBots: true }),
    skills: await listSkills(),
  }));
  app.get("/api/memory/file", async (req) => {
    const { path } = req.query as { path: string };
    return { path, content: await readMemory(path) };
  });
  app.put("/api/memory/file", async (req) => {
    const { path, content } = req.body as { path: string; content: string };
    return writeMemory(path, content ?? "", { actor: "user" });
  });
  app.delete("/api/memory/file", async (req) => {
    const { path } = req.query as { path: string };
    return deleteMemory(path, { actor: "user" });
  });
  app.get("/api/memory/history", async (req) => {
    const { path, limit } = req.query as { path?: string; limit?: string };
    return memoryHistory(path, Math.min(Number(limit ?? 100), 500));
  });
  app.post("/api/memory/revert/:eventId", async (req) => revertMemoryEvent((req.params as any).eventId));

  // ---------------- Routines ----------------
  app.get("/api/routines", async () => {
    const rows = await sql<(RoutineRow & { bot_name: string; last_status: string | null })[]>`
      select r.*, b.name as bot_name,
        (select status from runs where routine_id = r.id order by created_at desc limit 1) as last_status
      from routines r join bots b on b.id = r.bot_id order by r.created_at`;
    return rows.map((r) => ({ ...r, next_runs: r.enabled && r.cron ? nextRuns(r.cron, r.timezone) : [] }));
  });
  app.post("/api/routines", async (req, reply) => {
    const b = req.body as { botId: string; name: string; prompt: string; cron?: string | null; timezone?: string; enabled?: boolean };
    if (!b.botId || !b.name || !b.prompt) return reply.code(400).send({ error: "Bot, namn och instruktion krävs" });
    try {
      return await createRoutine({ botId: b.botId, name: b.name, prompt: b.prompt, cron: b.cron || null, timezone: b.timezone, enabled: b.enabled });
    } catch (err) {
      return reply.code(400).send({ error: `Ogiltigt schema: ${(err as Error).message}` });
    }
  });
  app.patch("/api/routines/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as Partial<{ botId: string; name: string; prompt: string; cron: string | null; timezone: string; enabled: boolean }>;
    const [cur] = await sql<RoutineRow[]>`select * from routines where id = ${id}`;
    if (!cur) return reply.code(404).send({ error: "not found" });
    const next = {
      bot_id: b.botId ?? cur.bot_id,
      name: b.name ?? cur.name,
      prompt: b.prompt ?? cur.prompt,
      cron: b.cron === undefined ? cur.cron : b.cron || null,
      timezone: b.timezone ?? cur.timezone,
      enabled: b.enabled ?? cur.enabled,
    };
    if (next.cron) {
      try {
        validateCron(next.cron, next.timezone);
      } catch (err) {
        return reply.code(400).send({ error: `Ogiltigt schema: ${(err as Error).message}` });
      }
    }
    const [r] = await sql<RoutineRow[]>`update routines set ${sql(next)}, updated_at = now() where id = ${id} returning *`;
    await syncRoutineSchedule(r);
    return r;
  });
  app.delete("/api/routines/:id", async (req) => {
    const { id } = req.params as { id: string };
    await removeRoutineSchedule(id);
    await sql`delete from routines where id = ${id}`;
    return { ok: true };
  });
  app.post("/api/routines/:id/run", async (req) => triggerRoutine((req.params as any).id, { manual: true }));
  app.get("/api/routines/:id/runs", async (req) => {
    return sql`select id, status, trigger, error, summary, step_count, created_at, started_at, finished_at, thread_id
      from runs where routine_id = ${(req.params as any).id} order by created_at desc limit 100`;
  });

  // Webhook trigger (no session – the secret in the URL is the credential).
  app.post("/api/hooks/:id/:secret", async (req, reply) => {
    const { id, secret } = req.params as { id: string; secret: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send();
    const [r] = await sql<RoutineRow[]>`select * from routines where id = ${id}`;
    const a = Buffer.from(secret);
    const b = Buffer.from(r?.webhook_secret ?? "x".repeat(secret.length + 1));
    if (!r || a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(404).send();
    const run = await triggerRoutine(id, { payload: req.body ?? {} });
    return { ok: true, runId: run?.id };
  });

  // ---------------- Audit log ----------------
  app.get("/api/audit", async (req) => {
    const q = req.query as { limit?: string; before?: string; botId?: string };
    return sql`select a.*, b.name as bot_name from audit_log a left join bots b on b.id = a.bot_id
      where true ${q.before ? sql`and a.id < ${q.before}` : sql``} ${q.botId ? sql`and a.bot_id = ${q.botId}` : sql``}
      order by a.id desc limit ${Math.min(Number(q.limit ?? 100), 500)}`;
  });

  // ---------------- Workstation ----------------
  app.get("/api/workstation/status", async () => {
    const health = await ws.health();
    const tabs = health.ok ? await ws.tabs().catch(() => []) : [];
    return { ...health, tabs };
  });
  app.get("/api/workstation/files", async (req) => ws.list((req.query as any).path ?? "."));
  app.get("/api/workstation/download", async (req, reply) => {
    const p = (req.query as any).path as string;
    const res = await ws.raw(p);
    const name = p.split("/").pop() ?? "fil";
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.type("application/octet-stream").send(Buffer.from(await res.arrayBuffer()));
  });

  // ---------------- Push notifications ----------------
  app.get("/api/push/key", async () => ({ publicKey: (await vapidKeys()).publicKey }));
  app.post("/api/push/subscribe", async (req) => {
    await saveSubscription(req.body as any, req.headers["user-agent"]);
    return { ok: true };
  });
  app.post("/api/push/unsubscribe", async (req) => {
    await removeSubscription((req.body as any).endpoint);
    return { ok: true };
  });
  app.post("/api/push/test", async () => {
    await notify({ title: "Crew", body: "Pushnotiser fungerar 🎉", url: "/", kind: "attention" });
    return { ok: true };
  });

  // ---------------- Settings ----------------
  app.get("/api/settings", async () => ({
    notifications: (await getSetting("notifications")) ?? { attention: true, done: true },
  }));
  app.put("/api/settings/notifications", async (req) => {
    await setSetting("notifications", req.body);
    return { ok: true };
  });

  // ---------------- MCP servers ----------------
  app.get("/api/mcp", async () => sql`select * from mcp_servers order by name`);
  app.post("/api/mcp", async (req, reply) => {
    const b = req.body as { name: string; transport: "http" | "stdio"; config: McpServerRow["config"]; botIds?: string[] };
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(b.name ?? "")) return reply.code(400).send({ error: "Namn: bokstäver, siffror, - och _" });
    if (b.transport === "http" && !b.config?.url) return reply.code(400).send({ error: "URL krävs" });
    if (b.transport === "stdio" && !b.config?.command) return reply.code(400).send({ error: "Kommando krävs" });
    const [row] = await sql`insert into mcp_servers (name, transport, config, bot_ids)
      values (${b.name}, ${b.transport}, ${json(b.config)}, ${b.botIds?.length ? b.botIds : null}) returning *`;
    return row;
  });
  app.patch("/api/mcp/:id", async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Partial<{ enabled: boolean; config: McpServerRow["config"]; botIds: string[] | null }>;
    const [cur] = await sql<McpServerRow[]>`select * from mcp_servers where id = ${id}`;
    await resetServer(cur);
    const [row] = await sql`update mcp_servers set
        enabled = ${b.enabled ?? cur.enabled},
        config = ${json(b.config ?? cur.config)},
        bot_ids = ${b.botIds === undefined ? cur.bot_ids : b.botIds?.length ? b.botIds : null}
      where id = ${id} returning *`;
    return row;
  });
  app.delete("/api/mcp/:id", async (req) => {
    const { id } = req.params as { id: string };
    const [cur] = await sql<McpServerRow[]>`select * from mcp_servers where id = ${id}`;
    if (cur) await resetServer(cur);
    await sql`delete from mcp_servers where id = ${id}`;
    return { ok: true };
  });
  app.post("/api/mcp/:id/test", async (req, reply) => {
    const [cur] = await sql<McpServerRow[]>`select * from mcp_servers where id = ${(req.params as any).id}`;
    if (!cur) return reply.code(404).send();
    try {
      await resetServer(cur);
      const tools = await listServerTools(cur);
      return { ok: true, tools: tools.map((t) => ({ name: t.name, description: t.description })) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
