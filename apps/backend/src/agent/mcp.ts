import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sql } from "../db.js";
import { ws } from "../workstation.js";

/**
 * MCP support. Two transports:
 *  - "http": remote MCP servers (streamable HTTP), connected from the worker.
 *  - "stdio": local servers (npx/uvx …) that run INSIDE the workstation
 *    (sandboxed, unprivileged) via the tool daemon's bridge.
 * Several servers of the same kind can be added (e.g. two Google accounts).
 */

export interface McpServerRow {
  id: string;
  name: string;
  transport: "http" | "stdio";
  config: { url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> };
  enabled: boolean;
  bot_ids: string[] | null;
}

export interface McpTool {
  server: McpServerRow;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const httpClients = new Map<string, { client: Client; key: string }>();

async function httpClient(s: McpServerRow) {
  const key = JSON.stringify(s.config);
  const existing = httpClients.get(s.id);
  if (existing && existing.key === key) return existing.client;
  if (existing) await existing.client.close().catch(() => {});
  const client = new Client({ name: "crew", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(s.config.url!), {
    requestInit: { headers: s.config.headers ?? {} },
  });
  await client.connect(transport);
  httpClients.set(s.id, { client, key });
  return client;
}

function stdioCfg(s: McpServerRow) {
  return { name: s.name, command: s.config.command, args: s.config.args ?? [], env: s.config.env ?? {} };
}

export async function listServers(botId?: string): Promise<McpServerRow[]> {
  const rows = await sql<McpServerRow[]>`select * from mcp_servers where enabled order by name`;
  return rows.filter((r) => !botId || !r.bot_ids || r.bot_ids.length === 0 || r.bot_ids.includes(botId));
}

function cleanSchema(schema: any): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || schema.type !== "object") return { type: "object", properties: {} };
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

const toolCache = new Map<string, { at: number; tools: McpTool[] }>();

export async function listServerTools(s: McpServerRow): Promise<McpTool[]> {
  const cacheKey = s.id + JSON.stringify(s.config);
  const cached = toolCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.tools;
  let raw: { name: string; description?: string; inputSchema?: any }[];
  if (s.transport === "http") {
    raw = (await (await httpClient(s)).listTools()).tools as any;
  } else {
    raw = ((await ws.mcp(stdioCfg(s), "tools/list", {})).result?.tools ?? []) as any;
  }
  const tools = raw.map((t) => ({
    server: s,
    name: t.name,
    description: t.description ?? "",
    inputSchema: cleanSchema(t.inputSchema),
  }));
  toolCache.set(cacheKey, { at: Date.now(), tools });
  return tools;
}

export async function callServerTool(s: McpServerRow, name: string, args: Record<string, unknown>): Promise<string> {
  let result: any;
  if (s.transport === "http") result = await (await httpClient(s)).callTool({ name, arguments: args });
  else result = (await ws.mcp(stdioCfg(s), "tools/call", { name, arguments: args })).result;
  const parts: string[] = [];
  for (const c of result?.content ?? []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "resource" && c.resource?.text) parts.push(c.resource.text);
    else parts.push(`[${c.type}]`);
  }
  if (result?.structuredContent && !parts.length) parts.push(JSON.stringify(result.structuredContent));
  const text = parts.join("\n") || "(no output)";
  if (result?.isError) throw new Error(text);
  return text.length > 30_000 ? text.slice(0, 30_000) + "\n…(truncated)" : text;
}

/** Tool names exposed to the model: mcp__<server>__<tool>, restricted to [a-zA-Z0-9_-]. */
export function mcpToolName(server: string, tool: string) {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export async function resetServer(s: McpServerRow) {
  for (const k of [...toolCache.keys()]) if (k.startsWith(s.id)) toolCache.delete(k);
  const c = httpClients.get(s.id);
  if (c) await c.client.close().catch(() => {});
  httpClients.delete(s.id);
  if (s.transport === "stdio") await ws.mcpStop(s.name).catch(() => {});
}
