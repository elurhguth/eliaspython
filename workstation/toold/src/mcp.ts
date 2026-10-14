import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { HOME } from "./system.js";

/**
 * Minimal stdio MCP bridge. stdio MCP servers run *inside* the workstation
 * (the bots' shared computer, as an unprivileged user) instead of next to the
 * database. The backend talks JSON-RPC to them through this HTTP bridge.
 */

export interface StdioServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface Proc {
  key: string;
  child: ChildProcessWithoutNullStreams;
  nextId: number;
  pending: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  ready: Promise<void>;
  stderr: string;
}

const procs = new Map<string, Proc>();

function keyOf(cfg: StdioServerConfig) {
  return createHash("sha256").update(JSON.stringify([cfg.command, cfg.args ?? [], cfg.env ?? {}])).digest("hex").slice(0, 16);
}

function send(p: Proc, method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
  const id = p.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      p.pending.delete(id);
      reject(new Error(`MCP ${method} timed out`));
    }, timeoutMs);
    p.pending.set(id, { resolve, reject, timer });
    p.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function start(cfg: StdioServerConfig): Proc {
  const key = keyOf(cfg);
  const child = spawn(cfg.command, cfg.args ?? [], {
    cwd: HOME,
    env: { ...process.env, HOME, WORKSTATION_TOKEN: "", ...(cfg.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const p: Proc = { key, child, nextId: 1, pending: new Map(), ready: Promise.resolve(), stderr: "" };
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === "number" && p.pending.has(msg.id)) {
          const h = p.pending.get(msg.id)!;
          clearTimeout(h.timer);
          p.pending.delete(msg.id);
          if (msg.error) h.reject(new Error(msg.error.message ?? "MCP error"));
          else h.resolve(msg.result);
        }
      } catch {
        /* non-JSON line, ignore */
      }
    }
  });
  child.stderr.on("data", (d) => {
    p.stderr = (p.stderr + d.toString()).slice(-4000);
  });
  child.on("exit", () => {
    for (const h of p.pending.values()) {
      clearTimeout(h.timer);
      h.reject(new Error(`MCP server ${cfg.name} exited. stderr: ${p.stderr.slice(-500)}`));
    }
    procs.delete(cfg.name);
  });
  p.ready = (async () => {
    await send(p, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "crew", version: "0.1.0" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  })();
  procs.set(cfg.name, p);
  return p;
}

export async function mcpRequest(cfg: StdioServerConfig, method: string, params: unknown) {
  let p = procs.get(cfg.name);
  if (p && p.key !== keyOf(cfg)) {
    p.child.kill();
    p = undefined;
  }
  if (!p) p = start(cfg);
  await p.ready;
  return send(p, method, params);
}

export function mcpStop(name: string) {
  const p = procs.get(name);
  if (p) p.child.kill();
  procs.delete(name);
}
