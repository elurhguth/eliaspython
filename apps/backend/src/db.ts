import postgres from "postgres";
import { config } from "./config.js";

export const sql = postgres(config.databaseUrl, {
  max: 10,
  onnotice: () => {},
  transform: { undefined: null },
});

export type Json = Parameters<typeof sql.json>[0];
export const json = (v: unknown) => sql.json(v as Json);

/** Ordered, append-only list of schema migrations. Never edit an applied one – add a new entry. */
const MIGRATIONS: string[] = [
  /* 001 initial schema */ `
  create extension if not exists pgcrypto;

  create table users (
    id uuid primary key default gen_random_uuid(),
    username text unique not null,
    password_hash text not null,
    created_at timestamptz not null default now()
  );

  create table sessions (
    id text primary key,
    user_id uuid not null references users(id) on delete cascade,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    user_agent text
  );

  create table passkeys (
    id text primary key,
    user_id uuid not null references users(id) on delete cascade,
    public_key bytea not null,
    counter bigint not null default 0,
    transports text[] not null default '{}',
    name text not null default 'Passkey',
    created_at timestamptz not null default now(),
    last_used_at timestamptz
  );

  create table settings (
    key text primary key,
    value jsonb not null
  );

  create table bots (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    slug text unique not null,
    role text not null default '',
    avatar text not null default '',
    color text not null default '#e8a25c',
    instructions text not null default '',
    provider text not null,
    model text not null,
    voice jsonb not null default '{}',
    is_lead boolean not null default false,
    sort int not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table threads (
    id uuid primary key default gen_random_uuid(),
    title text not null default '',
    kind text not null default 'direct',
    model_override jsonb,
    routine_id uuid,
    archived boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table thread_bots (
    thread_id uuid not null references threads(id) on delete cascade,
    bot_id uuid not null references bots(id) on delete cascade,
    primary key (thread_id, bot_id)
  );

  create table runs (
    id uuid primary key default gen_random_uuid(),
    thread_id uuid not null references threads(id) on delete cascade,
    bot_id uuid not null references bots(id) on delete cascade,
    status text not null default 'queued',
    trigger text not null default 'chat',
    routine_id uuid,
    parent_run_id uuid,
    depth int not null default 0,
    provider text,
    model text,
    error text,
    summary text,
    step_count int not null default 0,
    input_tokens bigint not null default 0,
    output_tokens bigint not null default 0,
    created_at timestamptz not null default now(),
    started_at timestamptz,
    finished_at timestamptz
  );
  create index runs_thread_idx on runs(thread_id, created_at desc);
  create index runs_status_idx on runs(status);

  create table messages (
    id uuid primary key default gen_random_uuid(),
    thread_id uuid not null references threads(id) on delete cascade,
    seq bigserial,
    author_type text not null,
    bot_id uuid references bots(id) on delete set null,
    run_id uuid references runs(id) on delete set null,
    role text not null,
    content jsonb not null,
    raw jsonb,
    created_at timestamptz not null default now()
  );
  create index messages_thread_idx on messages(thread_id, seq);

  create table run_steps (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references runs(id) on delete cascade,
    tool_call_id text,
    kind text not null,
    title text not null,
    detail jsonb not null default '{}',
    result jsonb,
    screenshot text,
    status text not null default 'running',
    created_at timestamptz not null default now(),
    finished_at timestamptz
  );
  create index run_steps_run_idx on run_steps(run_id, created_at);
  create unique index run_steps_call_idx on run_steps(run_id, tool_call_id) where tool_call_id is not null;

  create table approvals (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references runs(id) on delete cascade,
    bot_id uuid not null references bots(id) on delete cascade,
    thread_id uuid not null references threads(id) on delete cascade,
    tool_call_id text not null,
    kind text not null default 'approval',
    action_type text not null,
    summary text not null,
    detail jsonb not null default '{}',
    status text not null default 'pending',
    scope text,
    note text,
    created_at timestamptz not null default now(),
    decided_at timestamptz
  );
  create unique index approvals_call_idx on approvals(run_id, tool_call_id);

  create table policies (
    bot_id uuid not null references bots(id) on delete cascade,
    action_type text not null,
    decision text not null,
    updated_at timestamptz not null default now(),
    primary key (bot_id, action_type)
  );

  create table audit_log (
    id bigserial primary key,
    ts timestamptz not null default now(),
    bot_id uuid,
    run_id uuid,
    thread_id uuid,
    tool text not null,
    action_type text,
    params jsonb not null default '{}',
    outcome text not null,
    detail text
  );
  create index audit_ts_idx on audit_log(ts desc);

  create table routines (
    id uuid primary key default gen_random_uuid(),
    bot_id uuid not null references bots(id) on delete cascade,
    name text not null,
    prompt text not null,
    cron text,
    timezone text not null default 'Europe/Stockholm',
    enabled boolean not null default true,
    webhook_secret text not null,
    thread_id uuid references threads(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_run_at timestamptz
  );

  create table push_subscriptions (
    endpoint text primary key,
    keys jsonb not null,
    user_agent text,
    created_at timestamptz not null default now()
  );

  create table memory_events (
    id bigserial primary key,
    ts timestamptz not null default now(),
    bot_id uuid,
    run_id uuid,
    thread_id uuid,
    actor text not null,
    path text not null,
    action text not null,
    before text,
    after text
  );
  create index memory_events_path_idx on memory_events(path, ts desc);

  create table mcp_servers (
    id uuid primary key default gen_random_uuid(),
    name text unique not null,
    transport text not null,
    config jsonb not null,
    enabled boolean not null default true,
    bot_ids uuid[],
    created_at timestamptz not null default now()
  );

  create table attachments (
    id uuid primary key default gen_random_uuid(),
    thread_id uuid references threads(id) on delete cascade,
    filename text not null,
    mime text not null,
    size bigint not null,
    path text not null,
    created_at timestamptz not null default now()
  );
  `,
];

export async function migrate() {
  await sql`create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())`;
  // Serialize concurrent migrators (server + worker start at the same time).
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(424242)`;
    const rows = await tx<{ version: number }[]>`select version from schema_migrations`;
    const applied = new Set(rows.map((r) => r.version));
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const version = i + 1;
      if (applied.has(version)) continue;
      await tx.unsafe(MIGRATIONS[i]);
      await tx`insert into schema_migrations (version) values (${version})`;
      console.log(`[db] applied migration ${version}`);
    }
  });
}

export async function getSetting<T>(key: string): Promise<T | null> {
  const [row] = await sql<{ value: T }[]>`select value from settings where key = ${key}`;
  return row ? row.value : null;
}

export async function setSetting(key: string, value: unknown) {
  await sql`insert into settings (key, value) values (${key}, ${json(value)})
    on conflict (key) do update set value = excluded.value`;
}
