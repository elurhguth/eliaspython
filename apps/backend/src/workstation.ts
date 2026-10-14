import { config } from "./config.js";

/** HTTP client for the tool daemon running inside the workstation container. */

export class WorkstationError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call(path: string, init: RequestInit & { owner?: string; timeoutMs?: number } = {}) {
  const { owner, timeoutMs = 180_000, ...rest } = init;
  const res = await fetch(config.workstation.url + path, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      authorization: `Bearer ${config.workstation.token}`,
      ...(owner ? { "x-crew-owner": owner } : {}),
      ...(rest.body && typeof rest.body === "string" ? { "content-type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new WorkstationError(msg, res.status);
  }
  return res;
}

async function post<T>(path: string, body: unknown, owner?: string, timeoutMs?: number): Promise<T> {
  const res = await call(path, { method: "POST", body: JSON.stringify(body ?? {}), owner, timeoutMs });
  return (await res.json()) as T;
}

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  elements: string;
}

export const ws = {
  health: async () => {
    try {
      const res = await fetch(config.workstation.url + "/health", { signal: AbortSignal.timeout(3000) });
      return (await res.json()) as { ok: boolean; browser: boolean };
    } catch {
      return { ok: false, browser: false };
    }
  },
  shell: (command: string, cwd?: string, timeoutSec?: number) =>
    post<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>(
      "/shell",
      { command, cwd, timeoutSec },
      undefined,
      ((timeoutSec ?? 120) + 15) * 1000,
    ),
  read: (path: string) => post<{ path: string; size: number; truncated: boolean; content: string }>("/fs/read", { path }),
  write: (path: string, content: string, append = false) =>
    post<{ path: string; size: number }>("/fs/write", { path, content, append }),
  list: (path = ".") =>
    post<{ path: string; entries: { name: string; path: string; type: string; size: number; modified: string }[] }>(
      "/fs/list",
      { path },
    ),
  remove: (path: string) => post<{ deleted: string }>("/fs/delete", { path }),
  upload: async (path: string, data: Buffer) => {
    const res = await call(`/fs/upload?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      body: new Uint8Array(data),
      headers: { "content-type": "application/octet-stream" },
    });
    return (await res.json()) as { path: string; size: number };
  },
  raw: (path: string) => call(`/fs/raw?path=${encodeURIComponent(path)}`, { method: "GET" }),
  act: (owner: string, input: Record<string, unknown>) => post<Snapshot>("/browser/act", input, owner, 60_000),
  snapshot: (owner: string) => post<Snapshot>("/browser/snapshot", {}, owner),
  screenshot: async (owner: string, fullPage = false) => {
    const res = await call("/browser/screenshot", { method: "POST", body: JSON.stringify({ fullPage }), owner });
    return Buffer.from(await res.arrayBuffer());
  },
  tabs: async () => (await (await call("/browser/tabs", { method: "GET" })).json()) as { url: string; title: string; owner: string | null }[],
  mcp: (server: unknown, method: string, params?: unknown) =>
    post<{ result: any }>("/mcp/request", { server, method, params }, undefined, 120_000),
  mcpStop: (name: string) => post("/mcp/stop", { name }),
};
