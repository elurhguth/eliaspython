import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { sql } from "./db.js";
import { publish } from "./events.js";

/**
 * Memory is plain Markdown files on disk so the user can always read, edit and
 * delete what the bots remember:
 *   memory/shared/<name>.md        – shared by the whole crew
 *   memory/bots/<botId>/<name>.md  – private to one bot
 *   skills/<name>.md               – saved, reusable workflows ("skills")
 * Every write is logged in memory_events (with before/after) so changes are
 * visible in the chat and can be reverted.
 */

export const MEMORY_ROOT = () => path.join(config.dataDir, "memory");
export const SKILLS_ROOT = () => path.join(config.dataDir, "skills");

export interface MemoryFile {
  path: string; // logical path, e.g. "shared/preferenser.md"
  scope: "shared" | "bot" | "skill";
  botId: string | null;
  name: string;
  size: number;
  updatedAt: string;
}

export function slugifyName(name: string) {
  const base = name
    .trim()
    .replace(/\.md$/i, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return (base || "notes") + ".md";
}

/** Map a logical path to an absolute file path, rejecting anything outside the memory/skill roots. */
export function resolveLogical(logical: string): { abs: string; scope: MemoryFile["scope"]; botId: string | null } {
  const parts = logical.replace(/^\/+/, "").split("/");
  if (parts.some((p) => p === ".." || p === "" || p.startsWith("."))) throw new Error(`Invalid memory path: ${logical}`);
  if (parts[0] === "shared" && parts.length === 2) {
    return { abs: path.join(MEMORY_ROOT(), "shared", parts[1]), scope: "shared", botId: null };
  }
  if (parts[0] === "bots" && parts.length === 3 && /^[0-9a-f-]{36}$/.test(parts[1])) {
    return { abs: path.join(MEMORY_ROOT(), "bots", parts[1], parts[2]), scope: "bot", botId: parts[1] };
  }
  if (parts[0] === "skills" && parts.length === 2) {
    return { abs: path.join(SKILLS_ROOT(), parts[1]), scope: "skill", botId: null };
  }
  throw new Error(`Invalid memory path: ${logical} (use shared/<name>.md, bots/<botId>/<name>.md or skills/<name>.md)`);
}

async function listDir(dir: string, logicalPrefix: string, scope: MemoryFile["scope"], botId: string | null) {
  const out: MemoryFile[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (!st?.isFile()) continue;
    out.push({ path: `${logicalPrefix}/${name}`, scope, botId, name, size: st.size, updatedAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listMemory(opts: { botId?: string | null; includeAllBots?: boolean } = {}): Promise<MemoryFile[]> {
  const files = await listDir(path.join(MEMORY_ROOT(), "shared"), "shared", "shared", null);
  if (opts.includeAllBots) {
    const botDirs = await fs.readdir(path.join(MEMORY_ROOT(), "bots")).catch(() => [] as string[]);
    for (const id of botDirs) files.push(...(await listDir(path.join(MEMORY_ROOT(), "bots", id), `bots/${id}`, "bot", id)));
  } else if (opts.botId) {
    files.push(...(await listDir(path.join(MEMORY_ROOT(), "bots", opts.botId), `bots/${opts.botId}`, "bot", opts.botId)));
  }
  return files;
}

export async function listSkills(): Promise<MemoryFile[]> {
  return listDir(SKILLS_ROOT(), "skills", "skill", null);
}

export async function readMemory(logical: string): Promise<string> {
  const { abs } = resolveLogical(logical);
  return fs.readFile(abs, "utf8");
}

interface Actor {
  actor: "user" | "bot";
  botId?: string | null;
  runId?: string | null;
  threadId?: string | null;
}

export async function writeMemory(logical: string, content: string, who: Actor, mode: "replace" | "append" = "replace") {
  const { abs } = resolveLogical(logical);
  const before = await fs.readFile(abs, "utf8").catch(() => null);
  const after = mode === "append" && before ? before.replace(/\s*$/, "\n") + content : content;
  if (after.length > 200_000) throw new Error("Memory file too large (max 200 kB)");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, after, "utf8");
  const action = before === null ? "create" : mode === "append" ? "append" : "update";
  const [ev] = await sql<{ id: string }[]>`
    insert into memory_events (bot_id, run_id, thread_id, actor, path, action, before, after)
    values (${who.botId ?? null}, ${who.runId ?? null}, ${who.threadId ?? null}, ${who.actor}, ${logical}, ${action}, ${before}, ${after})
    returning id`;
  await publish({ type: "memory", path: logical, action, botId: who.botId ?? null, threadId: who.threadId ?? null });
  return { path: logical, action, eventId: ev.id, size: after.length };
}

export async function deleteMemory(logical: string, who: Actor) {
  const { abs } = resolveLogical(logical);
  const before = await fs.readFile(abs, "utf8");
  await fs.unlink(abs);
  await sql`
    insert into memory_events (bot_id, run_id, thread_id, actor, path, action, before, after)
    values (${who.botId ?? null}, ${who.runId ?? null}, ${who.threadId ?? null}, ${who.actor}, ${logical}, 'delete', ${before}, null)`;
  await publish({ type: "memory", path: logical, action: "delete", botId: who.botId ?? null, threadId: who.threadId ?? null });
  return { path: logical, action: "delete" };
}

/** Restore the state a file had *before* a given change. */
export async function revertMemoryEvent(eventId: string) {
  const [ev] = await sql<{ path: string; before: string | null }[]>`select path, before from memory_events where id = ${eventId}`;
  if (!ev) throw new Error("Unknown memory event");
  if (ev.before === null) return deleteMemory(ev.path, { actor: "user" }).catch(() => ({ path: ev.path, action: "noop" }));
  return writeMemory(ev.path, ev.before, { actor: "user" });
}

export async function memoryHistory(logical?: string, limit = 100) {
  if (logical) {
    return sql`select id, ts, bot_id, run_id, thread_id, actor, path, action, before, after
      from memory_events where path = ${logical} order by ts desc limit ${limit}`;
  }
  return sql`select id, ts, bot_id, run_id, thread_id, actor, path, action,
      left(coalesce(after, before, ''), 400) as preview
    from memory_events order by ts desc limit ${limit}`;
}

/** Build the memory section for a bot's system prompt. Small memories are inlined, large ones listed. */
export async function memoryPrompt(botId: string, budget = 16_000): Promise<string> {
  const files = await listMemory({ botId });
  const skills = await listSkills();
  if (!files.length && !skills.length) return "No memories saved yet.";
  const parts: string[] = [];
  let used = 0;
  for (const f of files) {
    const label = f.scope === "shared" ? `shared/${f.name}` : `mine/${f.name}`;
    let content = "";
    if (used < budget) {
      content = await fs.readFile(resolveLogical(f.path).abs, "utf8").catch(() => "");
      if (used + content.length > budget) content = content.slice(0, Math.max(0, budget - used)) + "\n…(truncated – use memory_read)";
      used += content.length;
    }
    parts.push(content ? `<memory file="${label}">\n${content.trim()}\n</memory>` : `<memory file="${label}" size="${f.size}" (not loaded – use memory_read)/>`);
  }
  if (skills.length) {
    parts.push(
      "Saved skills (reusable workflows – read with memory_read path=skills/<name>.md before doing that kind of task):\n" +
        skills.map((s) => `- skills/${s.name}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}
