import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { sql } from "../db.js";
import { deleteMemory, readMemory, slugifyName, writeMemory } from "../memory.js";
import type { BotRow, RunRow, ThreadRow } from "../types.js";
import { ws, type Snapshot } from "../workstation.js";
import { callServerTool, listServerTools, listServers, mcpToolName } from "./mcp.js";
import { autoReview, classifyShell, classifyText, type Risk } from "./policy.js";
import type { ToolSpec } from "./providers/types.js";
import { webFetch, webSearch } from "./web.js";

export interface ToolContext {
  run: RunRow;
  bot: BotRow;
  thread: ThreadRow;
  /** Save a screenshot for the live timeline; returns a data-dir relative ref. */
  saveScreenshot(buf: Buffer): Promise<string>;
  /** Hooks into orchestration (delegation, routines) – provided by the loop. */
  delegate(targetSlug: string, message: string): Promise<string>;
  createRoutine(input: { name: string; prompt: string; cron: string; timezone?: string }): Promise<string>;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
  /** Screenshot ref shown to the model (as an image) */
  image?: string;
  /** Screenshot ref only shown in the UI timeline */
  uiImage?: string;
}

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  /** Short human readable label for the timeline. */
  title(input: z.infer<S>): string;
  /** Return a Risk when this call needs the user's approval. */
  risk?(input: z.infer<S>, ctx: ToolContext): Promise<Risk | null> | Risk | null;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

function tool<S extends z.ZodTypeAny>(t: Tool<S>): Tool<S> {
  return t;
}

const intent = z
  .string()
  .describe("Kort beskrivning av vad åtgärden gör och varför, t.ex. 'Klicka Skicka för att skicka mejlet till Anna'. Används för godkännanden.");

function formatSnapshot(s: Snapshot, maxElements = 120) {
  const els = s.elements.split("\n").slice(0, maxElements).join("\n");
  return `URL: ${s.url}\nTitel: ${s.title}\n\n--- Sidtext ---\n${s.text}\n\n--- Interaktiva element (använd ref) ---\n${els || "(inga)"}`;
}

async function browserStep(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolOutput> {
  const owner = ctx.bot.id;
  const snap = await ws.act(owner, input);
  const shot = await ws.screenshot(owner).catch(() => null);
  const ref = shot ? await ctx.saveScreenshot(shot) : undefined;
  return { content: formatSnapshot(snap), uiImage: ref };
}

async function reviewed(text: string): Promise<Risk | null> {
  return classifyText(text) ?? (await autoReview(text));
}

export const builtinTools: Tool[] = [
  // ---------------- Browser ----------------
  tool({
    name: "browser_navigate",
    description:
      "Öppna en URL i din flik i den delade webbläsaren (samma inloggningar som resten av teamet). Returnerar sidans text och numrerade interaktiva element.",
    schema: z.object({ url: z.string().describe("Full URL eller domän") }),
    title: (i) => `Öppnar ${i.url}`,
    run: (i, ctx) => browserStep(ctx, { action: "navigate", url: i.url }),
  }),
  tool({
    name: "browser_snapshot",
    description: "Läs av aktuell sida i din flik: URL, text och numrerade interaktiva element (ref).",
    schema: z.object({}),
    title: () => "Läser av sidan",
    run: async (_i, ctx) => {
      const snap = await ws.snapshot(ctx.bot.id);
      return { content: formatSnapshot(snap) };
    },
  }),
  tool({
    name: "browser_click",
    description: "Klicka på ett element (ref från senaste avläsningen, alternativt CSS-selector eller x/y-koordinater).",
    schema: z.object({
      ref: z.union([z.number(), z.string()]).optional(),
      selector: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      intent,
    }),
    title: (i) => i.intent || `Klickar på ${i.ref ?? i.selector ?? `${i.x},${i.y}`}`,
    risk: (i) => reviewed(`Klick i webbläsaren: ${i.intent}`),
    run: (i, ctx) => browserStep(ctx, { action: "click", ref: i.ref, selector: i.selector, x: i.x, y: i.y }),
  }),
  tool({
    name: "browser_type",
    description:
      "Fyll i text i ett fält (ref/selector). Sätt submit=true för att trycka Enter efteråt. Lösenord och 2FA-koder får ALDRIG skrivas – använd request_takeover.",
    schema: z.object({
      ref: z.union([z.number(), z.string()]).optional(),
      selector: z.string().optional(),
      text: z.string(),
      submit: z.boolean().optional(),
      intent,
    }),
    title: (i) => i.intent || `Skriver i fält ${i.ref ?? i.selector}`,
    risk: (i) => (i.submit ? reviewed(`Skriver och skickar formulär: ${i.intent}`) : null),
    run: (i, ctx) => browserStep(ctx, { action: "type", ref: i.ref, selector: i.selector, text: i.text, submit: i.submit }),
  }),
  tool({
    name: "browser_select",
    description: "Välj ett alternativ i en <select>-lista.",
    schema: z.object({ ref: z.union([z.number(), z.string()]).optional(), selector: z.string().optional(), value: z.string(), intent }),
    title: (i) => i.intent || `Väljer ${i.value}`,
    run: (i, ctx) => browserStep(ctx, { action: "select", ref: i.ref, selector: i.selector, value: i.value }),
  }),
  tool({
    name: "browser_press",
    description: "Tryck en tangent (t.ex. Enter, Escape, Tab, ArrowDown) på aktuell sida.",
    schema: z.object({ key: z.string(), intent }),
    title: (i) => i.intent || `Trycker ${i.key}`,
    risk: (i) => (/enter/i.test(i.key) ? reviewed(`Trycker ${i.key}: ${i.intent}`) : null),
    run: (i, ctx) => browserStep(ctx, { action: "press", key: i.key }),
  }),
  tool({
    name: "browser_scroll",
    description: "Scrolla sidan upp eller ned.",
    schema: z.object({ direction: z.enum(["up", "down"]), amount: z.number().optional() }),
    title: (i) => `Scrollar ${i.direction === "up" ? "upp" : "ned"}`,
    run: (i, ctx) => browserStep(ctx, { action: "scroll", direction: i.direction, amount: i.amount }),
  }),
  tool({
    name: "browser_back",
    description: "Gå tillbaka till föregående sida.",
    schema: z.object({}),
    title: () => "Går tillbaka",
    run: (_i, ctx) => browserStep(ctx, { action: "back" }),
  }),
  tool({
    name: "browser_screenshot",
    description: "Ta en skärmdump av din flik och titta på den (använd när layout/bilder spelar roll).",
    schema: z.object({ full_page: z.boolean().optional() }),
    title: () => "Tar skärmdump",
    run: async (i, ctx) => {
      const buf = await ws.screenshot(ctx.bot.id, !!i.full_page);
      const ref = await ctx.saveScreenshot(buf);
      return { content: "Skärmdump tagen.", image: ref, uiImage: ref };
    },
  }),
  tool({
    name: "request_takeover",
    description:
      "Secure handoff: be användaren ta över webbläsaren för lösenord, 2FA, BankID, CAPTCHA eller annat känsligt. Körningen pausas tills användaren lämnar tillbaka kontrollen.",
    schema: z.object({ reason: z.string().describe("Vad användaren behöver göra, t.ex. 'Logga in på Gmail med BankID'") }),
    title: (i) => `Ber dig ta över: ${i.reason}`,
    // Handled specially by the loop (pauses the run).
    run: async () => ({ content: "" }),
  }),

  // ---------------- Terminal & files ----------------
  tool({
    name: "shell_run",
    description:
      "Kör ett bash-kommando på den delade Linux-datorn (användare crew, hem /home/crew). Python3, git, curl, jq finns. Långkörande saker: kör i bakgrunden med nohup.",
    schema: z.object({
      command: z.string(),
      cwd: z.string().optional().describe("Arbetskatalog relativt /home/crew"),
      timeout_sec: z.number().optional(),
    }),
    title: (i) => `$ ${i.command.length > 80 ? i.command.slice(0, 80) + "…" : i.command}`,
    risk: async (i) => classifyShell(i.command) ?? (await autoReview(`Shell command: ${i.command}`)),
    run: async (i) => {
      const r = await ws.shell(i.command, i.cwd, i.timeout_sec ?? 120);
      const parts = [`exit code: ${r.exitCode}${r.timedOut ? " (timeout)" : ""}`];
      if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
      return { content: parts.join("\n\n"), isError: r.exitCode !== 0 };
    },
  }),
  tool({
    name: "file_read",
    description: "Läs en textfil på datorn (sökväg relativt /home/crew eller absolut under den).",
    schema: z.object({ path: z.string() }),
    title: (i) => `Läser ${i.path}`,
    run: async (i) => {
      const r = await ws.read(i.path);
      return { content: `${r.path} (${r.size} bytes${r.truncated ? ", trunkerad" : ""}):\n\n${r.content}` };
    },
  }),
  tool({
    name: "file_write",
    description: "Skriv (eller lägg till i) en textfil på datorn. Skapar kataloger vid behov.",
    schema: z.object({ path: z.string(), content: z.string(), append: z.boolean().optional() }),
    title: (i) => `${i.append ? "Lägger till i" : "Skriver"} ${i.path}`,
    run: async (i) => {
      const r = await ws.write(i.path, i.content, !!i.append);
      return { content: `Sparade ${r.path} (${r.size} bytes).` };
    },
  }),
  tool({
    name: "file_list",
    description: "Lista filer i en katalog på datorn.",
    schema: z.object({ path: z.string().optional() }),
    title: (i) => `Listar ${i.path ?? "~"}`,
    run: async (i) => {
      const r = await ws.list(i.path ?? ".");
      return {
        content: `${r.path}\n` + r.entries.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.name}${e.type === "file" ? ` (${e.size} B)` : ""}`).join("\n"),
      };
    },
  }),
  tool({
    name: "file_delete",
    description: "Radera en fil eller katalog på datorn.",
    schema: z.object({ path: z.string() }),
    title: (i) => `Raderar ${i.path}`,
    risk: (i) => ({ actionType: "delete", reason: `radera ${i.path}` }),
    run: async (i) => {
      const r = await ws.remove(i.path);
      return { content: `Raderade ${r.deleted}.` };
    },
  }),

  // ---------------- Web ----------------
  tool({
    name: "web_search",
    description: "Sök på webben. Returnerar titlar, länkar och utdrag.",
    schema: z.object({ query: z.string(), count: z.number().optional() }),
    title: (i) => `Söker: ${i.query}`,
    run: async (i) => {
      const results = await webSearch(i.query, i.count ?? 8);
      if (!results.length) return { content: "Inga resultat." };
      return { content: results.map((r, n) => `${n + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n") };
    },
  }),
  tool({
    name: "web_fetch",
    description: "Hämta en webbsida som text utan webbläsaren (snabbt för artiklar, dokumentation, API:er). Använd webbläsaren för inloggade/interaktiva sidor.",
    schema: z.object({ url: z.string() }),
    title: (i) => `Hämtar ${i.url}`,
    run: async (i) => {
      const r = await webFetch(i.url);
      return { content: `${r.status} ${r.url} (${r.contentType})\n\n${r.text}`, isError: r.status >= 400 };
    },
  }),

  // ---------------- Memory & skills ----------------
  tool({
    name: "memory_write",
    description:
      "Spara något i minnet som Markdown. scope=shared delas med hela teamet (fakta om användaren, preferenser); scope=mine är ditt eget (hur du gör ditt jobb). Användaren kan se, ändra och radera allt minne. Spara inte hemligheter.",
    schema: z.object({
      scope: z.enum(["shared", "mine"]),
      file: z.string().describe("Filnamn, t.ex. 'preferenser' eller 'kontakter'"),
      content: z.string(),
      mode: z.enum(["replace", "append"]).optional().describe("append (standard) lägger till sist, replace ersätter filen"),
    }),
    title: (i) => `Sparar i minnet: ${i.scope === "shared" ? "delat" : "eget"}/${slugifyName(i.file)}`,
    run: async (i, ctx) => {
      const logical = i.scope === "shared" ? `shared/${slugifyName(i.file)}` : `bots/${ctx.bot.id}/${slugifyName(i.file)}`;
      const r = await writeMemory(logical, i.content, { actor: "bot", botId: ctx.bot.id, runId: ctx.run.id, threadId: ctx.thread.id }, i.mode ?? "append");
      return { content: `Minnet uppdaterat (${r.action}): ${logical}` };
    },
  }),
  tool({
    name: "memory_read",
    description: "Läs en minnesfil eller skill, t.ex. shared/preferenser.md, mine/rutiner.md eller skills/veckorapport.md.",
    schema: z.object({ path: z.string() }),
    title: (i) => `Läser minne ${i.path}`,
    run: async (i, ctx) => {
      const logical = i.path.replace(/^mine\//, `bots/${ctx.bot.id}/`);
      return { content: await readMemory(logical) };
    },
  }),
  tool({
    name: "memory_delete",
    description: "Radera en minnesfil (shared/x.md eller mine/x.md) som inte längre stämmer.",
    schema: z.object({ path: z.string() }),
    title: (i) => `Raderar minne ${i.path}`,
    run: async (i, ctx) => {
      const logical = i.path.replace(/^mine\//, `bots/${ctx.bot.id}/`);
      await deleteMemory(logical, { actor: "bot", botId: ctx.bot.id, runId: ctx.run.id, threadId: ctx.thread.id });
      return { content: `Raderade ${logical}` };
    },
  }),
  tool({
    name: "skill_save",
    description:
      "Spara ett lyckat arbetsflöde som en återanvändbar skill (Markdown med steg, sajter, fallgropar). Alla bots ser listan över skills.",
    schema: z.object({ name: z.string(), content: z.string() }),
    title: (i) => `Sparar skill ${slugifyName(i.name)}`,
    run: async (i, ctx) => {
      const logical = `skills/${slugifyName(i.name)}`;
      const r = await writeMemory(logical, i.content, { actor: "bot", botId: ctx.bot.id, runId: ctx.run.id, threadId: ctx.thread.id });
      return { content: `Skill sparad (${r.action}): ${logical}` };
    },
  }),
  tool({
    name: "search_history",
    description: "Sök i tidigare konversationer (alla trådar du varit med i) efter ett ord eller en fras.",
    schema: z.object({ query: z.string(), limit: z.number().optional() }),
    title: (i) => `Söker i historiken: ${i.query}`,
    run: async (i, ctx) => {
      const rows = await sql<{ title: string; created_at: Date; author_type: string; name: string | null; text: string }[]>`
        select t.title, m.created_at, m.author_type, b.name,
          (select string_agg(x->>'text', ' ') from jsonb_array_elements(m.content) x where x->>'type' = 'text') as text
        from messages m
        join threads t on t.id = m.thread_id
        left join bots b on b.id = m.bot_id
        where m.thread_id in (select thread_id from thread_bots where bot_id = ${ctx.bot.id})
          and m.role in ('user', 'assistant', 'note')
          and exists (select 1 from jsonb_array_elements(m.content) x where x->>'type' = 'text' and x->>'text' ilike ${"%" + i.query + "%"})
        order by m.created_at desc
        limit ${Math.min(i.limit ?? 10, 30)}`;
      if (!rows.length) return { content: "Inga träffar." };
      return {
        content: rows
          .map((r) => `[${new Date(r.created_at).toISOString().slice(0, 16)} · ${r.title || "chatt"} · ${r.author_type === "user" ? "Användaren" : (r.name ?? "system")}]\n${(r.text ?? "").slice(0, 500)}`)
          .join("\n\n"),
      };
    },
  }),

  // ---------------- Team & routines ----------------
  tool({
    name: "delegate",
    description:
      "Lämna över en uppgift till en annan bot i teamet (de delar dator, filer och inloggningar). Den andra boten svarar i samma tråd och kan @-nämna dig när den är klar.",
    schema: z.object({ bot: z.string().describe("Botens @namn (slug)"), message: z.string().describe("Uppgiften med all kontext som behövs") }),
    title: (i) => `Lämnar över till @${i.bot.replace(/^@/, "")}`,
    run: async (i, ctx) => ({ content: await ctx.delegate(i.bot.replace(/^@/, ""), i.message) }),
  }),
  tool({
    name: "routine_create",
    description:
      "Skapa en schemalagd routine (återkommande jobb) som du själv kör, t.ex. varje morgon. cron i 5-fältsformat (min tim dag mån veckodag), tidszon Europe/Stockholm om inget annat anges.",
    schema: z.object({ name: z.string(), prompt: z.string().describe("Instruktionen du får varje gång den körs"), cron: z.string(), timezone: z.string().optional() }),
    title: (i) => `Skapar routine "${i.name}" (${i.cron})`,
    risk: (i) => ({ actionType: "routine", reason: `ny routine ${i.cron}` }),
    run: async (i, ctx) => ({ content: await ctx.createRoutine(i) }),
  }),
];

/** JSON schema for the model from a zod schema. */
function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  if (js.type !== "object") return { type: "object", properties: {} };
  return js;
}

const MCP_WRITE = /(send|post|create|delete|remove|update|write|insert|edit|publish|reply|archive|move|upload|invite|share|pay|book)/i;

/** All tools for a bot: built-ins + its MCP tools. */
export async function toolsForBot(bot: BotRow): Promise<Tool[]> {
  const tools: Tool[] = [...builtinTools];
  for (const server of await listServers(bot.id)) {
    try {
      for (const t of await listServerTools(server)) {
        const name = mcpToolName(server.name, t.name);
        tools.push({
          name,
          description: `[MCP: ${server.name}] ${t.description}`.slice(0, 1024),
          schema: z.any(),
          jsonSchemaOverride: t.inputSchema,
          title: () => `${server.name}: ${t.name}`,
          risk: () => (MCP_WRITE.test(t.name) ? { actionType: "external", reason: `${server.name}.${t.name}` } : null),
          run: async (input: Record<string, unknown>) => ({ content: await callServerTool(server, t.name, input ?? {}) }),
        } as Tool & { jsonSchemaOverride: Record<string, unknown> });
      }
    } catch (err) {
      console.warn(`[mcp] ${server.name} unavailable:`, (err as Error).message);
    }
  }
  return tools;
}

export function toolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: (t as any).jsonSchemaOverride ?? jsonSchema(t.schema),
  }));
}

export async function saveScreenshotFile(runId: string, buf: Buffer): Promise<string> {
  const rel = path.join("screenshots", runId, `${randomUUID()}.jpg`);
  const abs = path.join(config.dataDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);
  return rel;
}
