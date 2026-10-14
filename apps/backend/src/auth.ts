import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { config } from "./config.js";
import { sql } from "./db.js";

export const COOKIE = "crew_session";

declare module "fastify" {
  interface FastifyRequest {
    user?: { id: string; username: string };
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function ensureAdminFromEnv() {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from users`;
  if (n === 0 && config.adminPassword) {
    await sql`insert into users (username, password_hash) values (${config.adminUsername}, ${await hash(config.adminPassword)})`;
    console.log(`[auth] created user "${config.adminUsername}" from ADMIN_PASSWORD`);
  }
}

async function createSession(reply: FastifyReply, userId: string, ua?: string) {
  const token = randomBytes(32).toString("base64url");
  await sql`insert into sessions (id, user_id, expires_at, user_agent)
    values (${sha(token)}, ${userId}, now() + ${config.sessionDays + " days"}::interval, ${ua ?? null})`;
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    maxAge: config.sessionDays * 86400,
  });
}

export async function userFromRequest(req: FastifyRequest) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  const [row] = await sql<{ id: string; username: string }[]>`
    select u.id, u.username from sessions s join users u on u.id = s.user_id
    where s.id = ${sha(token)} and s.expires_at > now()`;
  return row ?? null;
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const user = await userFromRequest(req);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  req.user = user;
}

// Simple in-memory brute-force protection.
const attempts = new Map<string, { n: number; until: number }>();
function tooMany(ip: string) {
  const a = attempts.get(ip);
  return a && a.n >= 10 && a.until > Date.now();
}
function failed(ip: string) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { n: 1, until: Date.now() + 15 * 60_000 });
  else a.n++;
}

const challenges = new Map<string, { challenge: string; userId?: string; at: number }>();
function storeChallenge(reply: FastifyReply, challenge: string, userId?: string) {
  const id = randomBytes(16).toString("hex");
  challenges.set(id, { challenge, userId, at: Date.now() });
  for (const [k, v] of challenges) if (Date.now() - v.at > 5 * 60_000) challenges.delete(k);
  reply.setCookie("crew_webauthn", id, { path: "/api/auth", httpOnly: true, sameSite: "strict", secure: config.secureCookies, maxAge: 300 });
}
function takeChallenge(req: FastifyRequest) {
  const id = req.cookies?.crew_webauthn;
  const c = id ? challenges.get(id) : undefined;
  if (id) challenges.delete(id);
  return c;
}

function rp() {
  const url = new URL(config.publicUrl);
  return { rpID: url.hostname, origin: url.origin, rpName: "Crew" };
}

export function authRoutes(app: FastifyInstance) {
  app.get("/api/auth/status", async (req) => {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from users`;
    const user = await userFromRequest(req);
    const [{ p }] = await sql<{ p: number }[]>`select count(*)::int as p from passkeys`;
    return { setupRequired: n === 0, user, passkeysAvailable: p > 0 };
  });

  app.post("/api/auth/setup", async (req, reply) => {
    const { username, password } = req.body as { username: string; password: string };
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from users`;
    if (n > 0) return reply.code(409).send({ error: "Redan konfigurerad" });
    if (!username || !password || password.length < 10) return reply.code(400).send({ error: "Lösenordet måste vara minst 10 tecken" });
    const [u] = await sql<{ id: string }[]>`insert into users (username, password_hash) values (${username.trim()}, ${await hash(password)}) returning id`;
    await createSession(reply, u.id, req.headers["user-agent"]);
    return { ok: true };
  });

  app.post("/api/auth/login", async (req, reply) => {
    if (tooMany(req.ip)) return reply.code(429).send({ error: "För många försök. Vänta en stund." });
    const { username, password } = req.body as { username: string; password: string };
    const [u] = await sql<{ id: string; password_hash: string }[]>`select id, password_hash from users where username = ${username ?? ""}`;
    if (!u || !(await verify(u.password_hash, password ?? "").catch(() => false))) {
      failed(req.ip);
      return reply.code(401).send({ error: "Fel användarnamn eller lösenord" });
    }
    attempts.delete(req.ip);
    await createSession(reply, u.id, req.headers["user-agent"]);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies?.[COOKIE];
    if (token) await sql`delete from sessions where id = ${sha(token)}`;
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireUser }, async (req) => ({ user: req.user }));

  // Used by Caddy forward_auth to protect the noVNC live view.
  app.get("/api/auth/check", async (req, reply) => {
    const user = await userFromRequest(req);
    return user ? { ok: true } : reply.code(401).send({ error: "unauthorized" });
  });

  app.post("/api/auth/password", { preHandler: requireUser }, async (req, reply) => {
    const { current, next } = req.body as { current: string; next: string };
    const [u] = await sql<{ password_hash: string }[]>`select password_hash from users where id = ${req.user!.id}`;
    if (!(await verify(u.password_hash, current ?? "").catch(() => false))) return reply.code(401).send({ error: "Fel nuvarande lösenord" });
    if (!next || next.length < 10) return reply.code(400).send({ error: "Minst 10 tecken" });
    await sql`update users set password_hash = ${await hash(next)} where id = ${req.user!.id}`;
    await sql`delete from sessions where user_id = ${req.user!.id} and id <> ${sha(req.cookies[COOKIE]!)}`;
    return { ok: true };
  });

  app.get("/api/auth/sessions", { preHandler: requireUser }, async (req) => {
    const current = sha(req.cookies[COOKIE]!);
    const rows = await sql<{ id: string; created_at: string; user_agent: string | null }[]>`
      select id, created_at, user_agent from sessions where user_id = ${req.user!.id} and expires_at > now() order by created_at desc`;
    return rows.map((r) => ({ id: r.id.slice(0, 12), created_at: r.created_at, user_agent: r.user_agent, current: r.id === current }));
  });

  app.post("/api/auth/sessions/revoke-others", { preHandler: requireUser }, async (req) => {
    await sql`delete from sessions where user_id = ${req.user!.id} and id <> ${sha(req.cookies[COOKIE]!)}`;
    return { ok: true };
  });

  // ---- Passkeys (WebAuthn) ----
  app.get("/api/auth/passkeys", { preHandler: requireUser }, async (req) => {
    return sql`select id, name, created_at, last_used_at from passkeys where user_id = ${req.user!.id} order by created_at`;
  });

  app.delete("/api/auth/passkeys/:id", { preHandler: requireUser }, async (req) => {
    await sql`delete from passkeys where id = ${(req.params as any).id} and user_id = ${req.user!.id}`;
    return { ok: true };
  });

  app.post("/api/auth/passkey/register/options", { preHandler: requireUser }, async (req, reply) => {
    const existing = await sql<{ id: string; transports: string[] }[]>`select id, transports from passkeys where user_id = ${req.user!.id}`;
    const { rpID, rpName } = rp();
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: req.user!.username,
      userID: new TextEncoder().encode(req.user!.id),
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports as any })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    storeChallenge(reply, options.challenge, req.user!.id);
    return options;
  });

  app.post("/api/auth/passkey/register/verify", { preHandler: requireUser }, async (req, reply) => {
    const c = takeChallenge(req);
    if (!c || c.userId !== req.user!.id) return reply.code(400).send({ error: "Utgången utmaning – försök igen" });
    const { response, name } = req.body as { response: any; name?: string };
    const { rpID, origin } = rp();
    const v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID });
    if (!v.verified || !v.registrationInfo) return reply.code(400).send({ error: "Kunde inte verifiera passkey" });
    const cred = v.registrationInfo.credential;
    await sql`insert into passkeys (id, user_id, public_key, counter, transports, name)
      values (${cred.id}, ${req.user!.id}, ${Buffer.from(cred.publicKey)}, ${cred.counter}, ${cred.transports ?? []}, ${name || "Passkey"})`;
    return { ok: true };
  });

  app.post("/api/auth/passkey/login/options", async (_req, reply) => {
    const { rpID } = rp();
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    storeChallenge(reply, options.challenge);
    return options;
  });

  app.post("/api/auth/passkey/login/verify", async (req, reply) => {
    if (tooMany(req.ip)) return reply.code(429).send({ error: "För många försök." });
    const c = takeChallenge(req);
    if (!c) return reply.code(400).send({ error: "Utgången utmaning – försök igen" });
    const { response } = req.body as { response: any };
    const [pk] = await sql<{ id: string; user_id: string; public_key: Buffer; counter: string; transports: string[] }[]>`
      select * from passkeys where id = ${response?.id ?? ""}`;
    if (!pk) {
      failed(req.ip);
      return reply.code(401).send({ error: "Okänd passkey" });
    }
    const { rpID, origin } = rp();
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports as any },
    });
    if (!v.verified) {
      failed(req.ip);
      return reply.code(401).send({ error: "Verifiering misslyckades" });
    }
    await sql`update passkeys set counter = ${v.authenticationInfo.newCounter}, last_used_at = now() where id = ${pk.id}`;
    await createSession(reply, pk.user_id, req.headers["user-agent"]);
    return { ok: true };
  });
}
