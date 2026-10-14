import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import * as browser from "./browser.js";
import * as sys from "./system.js";
import { mcpRequest, mcpStop } from "./mcp.js";

const TOKEN = process.env.WORKSTATION_TOKEN ?? "";
const PORT = Number(process.env.TOOLD_PORT ?? 7000);

if (!TOKEN || TOKEN.length < 16) {
  console.error("WORKSTATION_TOKEN must be set (min 16 chars)");
  process.exit(1);
}

const app = Fastify({ logger: { level: "info" }, bodyLimit: 100 * 1024 * 1024 });

app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

function authorized(header: string | undefined) {
  const given = Buffer.from((header ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/health") return;
  if (!authorized(req.headers.authorization)) return reply.code(401).send({ error: "unauthorized" });
});

app.setErrorHandler((err: any, _req, reply) => {
  const code = err instanceof browser.PasswordFieldError ? 422 : (err.statusCode ?? 500);
  reply.code(code).send({ error: err.message ?? String(err) });
});

const owner = (req: any) => String(req.headers["x-crew-owner"] ?? "default");

app.get("/health", async () => ({ ok: true, browser: await browser.browserHealthy() }));

// ---- shell ----
app.post("/shell", async (req) => {
  const { command, cwd, timeoutSec } = req.body as { command: string; cwd?: string; timeoutSec?: number };
  if (!command) throw Object.assign(new Error("command required"), { statusCode: 400 });
  return sys.runShell(command, cwd, timeoutSec);
});

// ---- files ----
app.post("/fs/read", async (req) => {
  const { path } = req.body as { path: string };
  return sys.readText(path);
});
app.post("/fs/write", async (req) => {
  const { path, content, append, base64 } = req.body as { path: string; content: string; append?: boolean; base64?: boolean };
  return sys.writeFile(path, base64 ? Buffer.from(content, "base64") : content, append);
});
app.post("/fs/list", async (req) => {
  const { path } = req.body as { path?: string };
  return sys.list(path ?? ".");
});
app.post("/fs/delete", async (req) => {
  const { path } = req.body as { path: string };
  return sys.remove(path);
});
app.put("/fs/upload", async (req) => {
  const { path } = req.query as { path: string };
  return sys.writeFile(path, req.body as Buffer);
});
app.get("/fs/raw", async (req, reply) => {
  const { path } = req.query as { path: string };
  sys.safePath(path);
  return reply.type("application/octet-stream").send(sys.rawStream(path));
});

// ---- browser ----
app.post("/browser/act", async (req) => browser.act(owner(req), req.body as browser.ActionInput));
app.post("/browser/snapshot", async (req) => browser.describe(owner(req)));
app.post("/browser/screenshot", async (req, reply) => {
  const { fullPage } = (req.body ?? {}) as { fullPage?: boolean };
  const img = await browser.screenshot(owner(req), !!fullPage);
  return reply.type("image/jpeg").send(img);
});
app.get("/browser/tabs", async () => browser.tabs());
app.post("/browser/close", async (req) => {
  await browser.closeOwner(owner(req));
  return { ok: true };
});

// ---- MCP stdio bridge ----
app.post("/mcp/request", async (req) => {
  const { server, method, params } = req.body as { server: any; method: string; params?: unknown };
  return { result: await mcpRequest(server, method, params ?? {}) };
});
app.post("/mcp/stop", async (req) => {
  mcpStop((req.body as any).name);
  return { ok: true };
});

app.listen({ host: "0.0.0.0", port: PORT }).catch((err) => {
  console.error(err);
  process.exit(1);
});
