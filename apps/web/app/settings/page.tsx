"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, Cpu, KeyRound, LogOut, Monitor, Plug, Plus, RefreshCw, Shield, Smartphone, Trash2 } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import { Shell } from "@/components/Shell";
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Textarea, Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import { useCrew } from "@/lib/store";
import { currentSubscription, disablePush, enablePush, pushSupported } from "@/lib/push";
import { dateTime } from "@/lib/format";

function Section({ icon, title, children, description, id }: { icon: React.ReactNode; title: string; description?: string; children: React.ReactNode; id?: string }) {
  return (
    <Card className="scroll-mt-6 p-5">
      {id && <span id={id} />}
      <div className="mb-4 flex items-start gap-3">
        <div className="mt-0.5 text-ember">{icon}</div>
        <div>
          <div className="font-medium">{title}</div>
          {description && <div className="mt-0.5 text-sm text-muted">{description}</div>}
        </div>
      </div>
      {children}
    </Card>
  );
}

function SettingsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
        <PageHeader title="Inställningar" />
        <Notifications />
        <Models />
        <Mcp />
        <Workstation />
        <Account />
        <InstallHint />
      </div>
    </div>
  );
}

function Notifications() {
  const [enabled, setEnabled] = useState(false);
  const [prefs, setPrefs] = useState({ attention: true, done: true });
  const [msg, setMsg] = useState("");
  useEffect(() => {
    currentSubscription().then((s) => setEnabled(!!s));
    api.get<{ notifications: typeof prefs }>("/api/settings").then((s) => setPrefs(s.notifications));
  }, []);
  const savePrefs = async (p: typeof prefs) => {
    setPrefs(p);
    await api.put("/api/settings/notifications", p);
  };
  return (
    <Section icon={<Bell size={18} />} title="Pushnotiser" description="Få en notis när en bot behöver dig eller är klar – även när appen är stängd.">
      {!pushSupported() ? (
        <div className="text-sm text-muted">Stöds inte här. På iPhone/iPad: öppna Crew i Safari → Dela → Lägg till på hemskärmen, och öppna appen därifrån. Kräver HTTPS.</div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm">Notiser på den här enheten</span>
            <Toggle
              checked={enabled}
              onChange={async (v) => {
                setMsg("");
                try {
                  if (v) await enablePush();
                  else await disablePush();
                  setEnabled(v);
                } catch (e) {
                  setMsg((e as Error).message);
                }
              }}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-ink2">När en bot behöver mig (godkännande, handoff, fel)</span>
            <Toggle checked={prefs.attention} onChange={(v) => savePrefs({ ...prefs, attention: v })} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-ink2">När en bot är klar med ett längre jobb eller en routine</span>
            <Toggle checked={prefs.done} onChange={(v) => savePrefs({ ...prefs, done: v })} />
          </div>
          {enabled && (
            <Button size="sm" variant="subtle" onClick={() => api.post("/api/push/test")}>
              Skicka testnotis
            </Button>
          )}
          {msg && <div className="text-sm text-danger">{msg}</div>}
        </div>
      )}
    </Section>
  );
}

function Models() {
  const crew = useCrew();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <Section icon={<Cpu size={18} />} title="Modeller" description="Varje bot kan använda valfri modell. Nycklar läggs i .env på servern – aldrig i webbläsaren.">
      <div className="space-y-2">
        {crew.models.providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded-xl border border-line bg-panel2 px-3 py-2 text-sm">
            <span>{p.label}</span>
            {p.configured ? (
              p.error ? (
                <span title={p.error}>
                  <Badge tone="danger">Fel</Badge>
                </span>
              ) : (
                <Badge tone="ok">{crew.models.models.filter((m) => m.provider === p.id).length} modeller</Badge>
              )
            ) : (
              <Badge>Ej konfigurerad</Badge>
            )}
          </div>
        ))}
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="mt-3"
        disabled={refreshing}
        onClick={async () => {
          setRefreshing(true);
          await api.get("/api/models?refresh=1");
          await crew.refresh();
          setRefreshing(false);
        }}
      >
        <RefreshCw size={13} /> Uppdatera modellistor
      </Button>
    </Section>
  );
}

interface McpServer {
  id: string;
  name: string;
  transport: "http" | "stdio";
  config: { url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> };
  enabled: boolean;
  bot_ids: string[] | null;
}

function Mcp() {
  const crew = useCrew();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [adding, setAdding] = useState(false);
  const [test, setTest] = useState<Record<string, string>>({});
  const load = useCallback(async () => setServers(await api.get<McpServer[]>("/api/mcp")), []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Section
      id="mcp"
      icon={<Plug size={18} />}
      title="Källor & verktyg (MCP)"
      description="Koppla MCP-servrar för extra verktyg och datakällor. Lokala (stdio) servrar körs isolerat på botarnas dator. Du kan lägga till flera av samma typ, t.ex. två konton."
    >
      <div className="space-y-2">
        {servers.length === 0 && <div className="text-sm text-muted">Inga MCP-servrar kopplade.</div>}
        {servers.map((s) => (
          <div key={s.id} className="rounded-xl border border-line bg-panel2 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="font-medium">{s.name}</span>
              <Badge>{s.transport === "http" ? "HTTP" : "lokal"}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-faint">
                {s.transport === "http" ? s.config.url : [s.config.command, ...(s.config.args ?? [])].join(" ")}
              </span>
              <Toggle
                checked={s.enabled}
                onChange={async (v) => {
                  await api.patch(`/api/mcp/${s.id}`, { enabled: v });
                  load();
                }}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>{s.bot_ids?.length ? `Bara: ${s.bot_ids.map((id) => crew.botById(id)?.name).join(", ")}` : "Alla botar"}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  setTest((t) => ({ ...t, [s.id]: "Testar…" }));
                  const r = await api.post<{ ok: boolean; tools?: { name: string }[]; error?: string }>(`/api/mcp/${s.id}/test`);
                  setTest((t) => ({ ...t, [s.id]: r.ok ? `✓ ${r.tools!.length} verktyg: ${r.tools!.map((x) => x.name).join(", ")}` : `✗ ${r.error}` }));
                }}
              >
                Testa
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (confirm(`Ta bort ${s.name}?`)) {
                    await api.del(`/api/mcp/${s.id}`);
                    load();
                  }
                }}
              >
                <Trash2 size={13} />
              </Button>
            </div>
            {test[s.id] && <div className="mt-1 break-words text-xs text-ink2">{test[s.id]}</div>}
          </div>
        ))}
      </div>
      <Button size="sm" variant="subtle" className="mt-3" onClick={() => setAdding(true)}>
        <Plus size={13} /> Lägg till MCP-server
      </Button>
      <AddMcp open={adding} onClose={() => setAdding(false)} onSaved={load} />
    </Section>
  );
}

function AddMcp({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const crew = useCrew();
  const [form, setForm] = useState({ name: "", transport: "http" as "http" | "stdio", url: "", headers: "", command: "npx", args: "", env: "", bots: [] as string[] });
  const [error, setError] = useState("");
  const parseKV = (s: string) =>
    Object.fromEntries(
      s
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const i = l.search(/[:=]/);
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
  async function save() {
    setError("");
    try {
      await api.post("/api/mcp", {
        name: form.name,
        transport: form.transport,
        botIds: form.bots,
        config:
          form.transport === "http"
            ? { url: form.url, headers: parseKV(form.headers) }
            : { command: form.command, args: form.args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? [], env: parseKV(form.env) },
      });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Lägg till MCP-server" footer={<Button variant="primary" onClick={save}>Spara</Button>}>
      <div className="space-y-3">
        <Field label="Namn" hint="Kort, t.ex. github eller gmail-jobb">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Typ">
          <Select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value as "http" | "stdio" })}>
            <option value="http">Fjärrserver (Streamable HTTP)</option>
            <option value="stdio">Lokal (stdio – körs på botarnas dator)</option>
          </Select>
        </Field>
        {form.transport === "http" ? (
          <>
            <Field label="URL">
              <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/mcp" />
            </Field>
            <Field label="Headers (en per rad)" hint="t.ex. Authorization: Bearer …">
              <Textarea rows={3} value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} className="font-mono text-xs" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Kommando">
              <Input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
            </Field>
            <Field label="Argument">
              <Input value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem /home/crew" className="font-mono text-xs" />
            </Field>
            <Field label="Miljövariabler (NAMN=värde per rad)">
              <Textarea rows={3} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} className="font-mono text-xs" />
            </Field>
          </>
        )}
        <div>
          <div className="mb-1.5 text-[13px] font-medium text-ink2">Vilka botar får använda den?</div>
          <div className="flex flex-wrap gap-1.5">
            {crew.bots.map((b) => {
              const on = form.bots.includes(b.id);
              return (
                <button
                  key={b.id}
                  onClick={() => setForm({ ...form, bots: on ? form.bots.filter((x) => x !== b.id) : [...form.bots, b.id] })}
                  className={`rounded-full border px-3 py-1 text-xs ${on ? "border-ember/50 bg-ember/10" : "border-line text-ink2"}`}
                >
                  {b.name}
                </button>
              );
            })}
          </div>
          <div className="mt-1 text-xs text-faint">Inga valda = alla botar.</div>
        </div>
        {error && <div className="text-sm text-danger">{error}</div>}
      </div>
    </Modal>
  );
}

function Workstation() {
  const [status, setStatus] = useState<{ ok: boolean; browser: boolean; tabs: { url: string; title: string; owner: string | null }[] } | null>(null);
  const crew = useCrew();
  useEffect(() => {
    api.get<typeof status>("/api/workstation/status").then(setStatus);
  }, []);
  return (
    <Section icon={<Monitor size={18} />} title="Datorn" description="Botarnas gemensamma dator: webbläsare, filer och terminal.">
      {!status ? (
        <div className="text-sm text-muted">Hämtar…</div>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex gap-2">
            <Badge tone={status.ok ? "ok" : "danger"}>{status.ok ? "Igång" : "Svarar inte"}</Badge>
            <Badge tone={status.browser ? "ok" : "danger"}>{status.browser ? "Webbläsare OK" : "Webbläsare saknas"}</Badge>
          </div>
          {status.tabs.length > 0 && (
            <div className="rounded-xl border border-line bg-panel2 p-2">
              <div className="mb-1 text-xs text-muted">Öppna flikar</div>
              {status.tabs.map((t, i) => (
                <div key={i} className="truncate text-xs text-ink2">
                  {t.owner ? `${crew.botById(t.owner)?.name ?? "?"}: ` : ""}
                  {t.title || t.url}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function Account() {
  const crew = useCrew();
  const [passkeys, setPasskeys] = useState<{ id: string; name: string; created_at: string; last_used_at: string | null }[]>([]);
  const [sessions, setSessions] = useState<{ id: string; created_at: string; user_agent: string | null; current: boolean }[]>([]);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    setPasskeys(await api.get("/api/auth/passkeys"));
    setSessions(await api.get("/api/auth/sessions"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Section icon={<Shield size={18} />} title="Konto & säkerhet" description={`Inloggad som ${crew.user.username}.`}>
      <div className="space-y-5">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <KeyRound size={15} /> Passkeys
          </div>
          {passkeys.map((p) => (
            <div key={p.id} className="mb-1.5 flex items-center justify-between rounded-xl border border-line bg-panel2 px-3 py-2 text-sm">
              <span>
                {p.name} <span className="text-xs text-faint">· skapad {dateTime(p.created_at)}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => api.del(`/api/auth/passkeys/${encodeURIComponent(p.id)}`).then(load)}>
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="subtle"
            onClick={async () => {
              setMsg("");
              try {
                const options = await api.post<any>("/api/auth/passkey/register/options");
                const response = await startRegistration({ optionsJSON: options });
                const name = prompt("Namn på passkeyn (t.ex. iPhone)", "Passkey") ?? "Passkey";
                await api.post("/api/auth/passkey/register/verify", { response, name });
                load();
              } catch (e) {
                setMsg((e as Error).message);
              }
            }}
          >
            <Plus size={13} /> Lägg till passkey
          </Button>
          <div className="mt-1 text-xs text-faint">Kräver HTTPS och att PUBLIC_URL i .env matchar adressen du använder.</div>
        </div>

        <div>
          <div className="mb-2 text-sm font-medium">Byt lösenord</div>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input type="password" placeholder="Nuvarande" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
            <Input type="password" placeholder="Nytt (minst 10 tecken)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
            <Button
              onClick={async () => {
                setMsg("");
                try {
                  await api.post("/api/auth/password", pw);
                  setPw({ current: "", next: "" });
                  setMsg("Lösenordet är bytt. Andra enheter loggades ut.");
                } catch (e) {
                  setMsg((e as Error).message);
                }
              }}
            >
              Byt
            </Button>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <Smartphone size={15} /> Inloggade enheter
          </div>
          {sessions.map((s) => (
            <div key={s.id} className="mb-1 flex items-center gap-2 text-xs text-ink2">
              <span className="min-w-0 flex-1 truncate">{s.user_agent ?? "Okänd"}</span>
              <span className="text-faint">{dateTime(s.created_at)}</span>
              {s.current && <Badge tone="ember">Den här</Badge>}
            </div>
          ))}
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => api.post("/api/auth/sessions/revoke-others").then(load)}>
              Logga ut andra enheter
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await api.post("/api/auth/logout");
                location.href = "/login";
              }}
            >
              <LogOut size={13} /> Logga ut
            </Button>
          </div>
        </div>
        {msg && <div className="text-sm text-ink2">{msg}</div>}
      </div>
    </Section>
  );
}

function InstallHint() {
  return (
    <Section icon={<Smartphone size={18} />} title="Installera appen" description="Crew är en PWA – installera den som en app på mobilen och datorn.">
      <ul className="list-disc space-y-1 pl-5 text-sm text-ink2">
        <li>iPhone/iPad: Safari → Dela → Lägg till på hemskärmen.</li>
        <li>Android: Chrome → ⋮ → Installera app.</li>
        <li>Dator: Chrome/Edge → installera-ikonen i adressfältet.</li>
      </ul>
    </Section>
  );
}

export default function Page() {
  return (
    <Shell>
      <SettingsPage />
    </Shell>
  );
}
