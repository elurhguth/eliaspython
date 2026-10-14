import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

export const HOME = process.env.CREW_HOME ?? "/home/crew";
const MAX_OUTPUT = 30_000;

/** Resolve a user/model supplied path and refuse anything that escapes HOME. */
export function safePath(p: string): string {
  const resolved = path.resolve(HOME, p || ".");
  const rel = path.relative(HOME, resolved);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the workstation home (${HOME}): ${p}`);
  }
  return resolved;
}

function clip(s: string) {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT / 2) + "\n…(output truncated)…\n" + s.slice(-MAX_OUTPUT / 2) : s;
}

export async function runShell(command: string, cwd = ".", timeoutSec = 120) {
  const dir = safePath(cwd);
  await fs.mkdir(dir, { recursive: true });
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: dir,
      env: { ...process.env, HOME, TERM: "dumb", WORKSTATION_TOKEN: "" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT * 4) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT * 4) stderr += d.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.min(timeoutSec, 1800) * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: clip(stdout), stderr: clip(stderr), timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: String(err), timedOut });
    });
  });
}

export async function readText(p: string, maxBytes = 200_000) {
  const file = safePath(p);
  const stat = await fs.stat(file);
  if (stat.isDirectory()) throw new Error(`${p} is a directory`);
  const fh = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
    await fh.read(buf, 0, buf.length, 0);
    return { path: file, size: stat.size, truncated: stat.size > maxBytes, content: buf.toString("utf8") };
  } finally {
    await fh.close();
  }
}

export async function writeFile(p: string, content: string | Buffer, append = false) {
  const file = safePath(p);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (append) await fs.appendFile(file, content);
  else await fs.writeFile(file, content);
  const stat = await fs.stat(file);
  return { path: file, size: stat.size };
}

export async function list(p: string) {
  const dir = safePath(p);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith(".") || p.includes("/."))
      .map(async (e) => {
        const full = path.join(dir, e.name);
        const st = await fs.stat(full).catch(() => null);
        return {
          name: e.name,
          path: full,
          type: e.isDirectory() ? "dir" : "file",
          size: st?.size ?? 0,
          modified: st?.mtime.toISOString() ?? null,
        };
      }),
  );
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: dir, entries: out };
}

export async function remove(p: string) {
  const file = safePath(p);
  if (file === HOME) throw new Error("Refusing to delete the home directory");
  await fs.rm(file, { recursive: true, force: false });
  return { deleted: file };
}

export function rawStream(p: string) {
  return createReadStream(safePath(p));
}
