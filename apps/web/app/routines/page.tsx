"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CalendarClock, History, Pencil, Play, Plus, Trash2, Webhook } from "lucide-react";
import { Shell } from "@/components/Shell";
import { Badge, BotAvatar, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Textarea, Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import { useCrew, useCrewEvent } from "@/lib/store";
import { dateTime, duration, STATUS_LABEL, timeAgo } from "@/lib/format";

interface Routine {
  id: string;
  bot_id: string;
  bot_name: string;
  name: string;
  prompt: string;
  cron: string | null;
  timezone: string;
  enabled: boolean;
  webhook_secret: string;
  thread_id: string | null;
  last_run_at: string | null;
  last_status: string | null;
  next_runs: string[];
}

interface RoutineRun {
  id: string;
  status: string;
  trigger: string;
  error: string | null;
  summary: string | null;
  step_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  thread_id: string;
}

const PRESETS: [string, string][] = [
  ["Varje morgon 07:30", "30 7 * * *"],
  ["Vardagar 08:00", "0 8 * * 1-5"],
  ["Varje timme", "0 * * * *"],
  ["Var 15:e minut", "*/15 * * * *"],
  ["Måndagar 09:00", "0 9 * * 1"],
  ["Första dagen i månaden", "0 9 1 * *"],
];

function describeCron(cron: string | null) {
  if (!cron) return "Bara manuellt / webhook";
  const p = PRESETS.find(([, c]) => c === cron);
  return p ? p[0] : cron;
}

function RoutinesPage() {
  const crew = useCrew();
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [historyFor, setHistoryFor] = useState<Routine | null>(null);

  const load = useCallback(async () => setRoutines(await api.get<Routine[]>("/api/routines")), []);
  useEffect(() => {
    load();
  }, [load]);
  useCrewEvent((e) => (e.type === "routine" || (e.type === "run" && e.run.routine_id)) && load(), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <PageHeader
          title="Routines"
          subtitle="Återkommande jobb som botarna kör själva enligt schema – eller när en webhook anropas."
          actions={
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus size={15} /> Ny routine
            </Button>
          }
        />
        {!routines ? (
          <Spinner />
        ) : routines.length === 0 ? (
          <Card>
            <Empty
              icon={<CalendarClock size={28} />}
              title="Inga routines än"
              text="Be en bot ”varje morgon, sammanfatta mina mejl” – eller skapa en här."
              action={
                <Button variant="primary" onClick={() => setEditing("new")}>
                  Skapa routine
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="space-y-3">
            {routines.map((r) => {
              const bot = crew.botById(r.bot_id);
              return (
                <Card key={r.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <BotAvatar bot={bot} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{r.name}</span>
                        {!r.enabled && <Badge>Pausad</Badge>}
                        {r.last_status && (
                          <Badge tone={r.last_status === "done" ? "ok" : r.last_status === "error" ? "danger" : "ember"}>{STATUS_LABEL[r.last_status]}</Badge>
                        )}
                      </div>
                      <div className="mt-0.5 text-sm text-muted">
                        {bot?.name} · {describeCron(r.cron)}
                        {r.cron && ` (${r.timezone})`}
                      </div>
                      <div className="mt-2 line-clamp-2 text-sm text-ink2">{r.prompt}</div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
                        <span>Senast: {r.last_run_at ? timeAgo(r.last_run_at) : "aldrig"}</span>
                        {r.enabled && r.next_runs[0] && <span>Nästa: {dateTime(r.next_runs[0])}</span>}
                      </div>
                    </div>
                    <Toggle
                      checked={r.enabled}
                      onChange={async (v) => {
                        await api.patch(`/api/routines/${r.id}`, { enabled: v });
                        load();
                      }}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                    <Button size="sm" variant="subtle" onClick={() => api.post(`/api/routines/${r.id}/run`).then(load)}>
                      <Play size={13} /> Kör nu
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setHistoryFor(r)}>
                      <History size={13} /> Körningar
                    </Button>
                    {r.thread_id && (
                      <Link href={`/?t=${r.thread_id}`} className="inline-flex h-8 items-center gap-1.5 rounded-xl px-3 text-[13px] text-ink2 hover:bg-raise">
                        Öppna tråd
                      </Link>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        navigator.clipboard.writeText(`${location.origin}/api/hooks/${r.id}/${r.webhook_secret}`);
                        alert("Webhook-URL kopierad. POST:a JSON till den för att starta routinen med data.");
                      }}
                    >
                      <Webhook size={13} /> Webhook
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(r)} className="ml-auto">
                      <Pencil size={13} /> Redigera
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (confirm(`Ta bort routinen "${r.name}"?`)) {
                          await api.del(`/api/routines/${r.id}`);
                          load();
                        }
                      }}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
      <RoutineEditor routine={editing === "new" ? null : editing} open={editing !== null} onClose={() => setEditing(null)} onSaved={load} />
      <RunHistory routine={historyFor} onClose={() => setHistoryFor(null)} />
    </div>
  );
}

function RoutineEditor({ routine, open, onClose, onSaved }: { routine: Routine | null; open: boolean; onClose: () => void; onSaved: () => void }) {
  const crew = useCrew();
  const [form, setForm] = useState({ botId: "", name: "", prompt: "", cron: "30 7 * * *", timezone: "Europe/Stockholm", enabled: true });
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setError("");
    setForm(
      routine
        ? { botId: routine.bot_id, name: routine.name, prompt: routine.prompt, cron: routine.cron ?? "", timezone: routine.timezone, enabled: routine.enabled }
        : { botId: (crew.bots.find((b) => b.is_lead) ?? crew.bots[0])?.id ?? "", name: "", prompt: "", cron: "30 7 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Stockholm", enabled: true },
    );
  }, [open, routine, crew.bots]);

  async function save() {
    setError("");
    try {
      if (routine) await api.patch(`/api/routines/${routine.id}`, { ...form, cron: form.cron || null });
      else await api.post("/api/routines", { ...form, cron: form.cron || null });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={routine ? "Redigera routine" : "Ny routine"}
      footer={
        <Button variant="primary" onClick={save} disabled={!form.name || !form.prompt || !form.botId}>
          Spara
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Namn">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Morgonbrief" />
        </Field>
        <Field label="Bot">
          <Select value={form.botId} onChange={(e) => setForm({ ...form, botId: e.target.value })}>
            {crew.bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} – {b.role}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Instruktion" hint="Vad boten ska göra varje gång.">
          <Textarea rows={5} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="Gå igenom min inkorg och kalender och skicka en kort sammanfattning av dagen." />
        </Field>
        <Field label="Schema (cron)" hint="minut timme dag månad veckodag. Lämna tomt för bara manuellt/webhook.">
          <Input value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} className="font-mono" />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map(([label, cron]) => (
            <button key={cron} onClick={() => setForm({ ...form, cron })} className="rounded-full border border-line px-2.5 py-1 text-xs text-ink2 hover:border-line2">
              {label}
            </button>
          ))}
        </div>
        <Field label="Tidszon">
          <Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
        </Field>
        {error && <div className="text-sm text-danger">{error}</div>}
      </div>
    </Modal>
  );
}

function RunHistory({ routine, onClose }: { routine: Routine | null; onClose: () => void }) {
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  useEffect(() => {
    if (routine) api.get<RoutineRun[]>(`/api/routines/${routine.id}/runs`).then(setRuns);
    else setRuns(null);
  }, [routine]);
  return (
    <Modal open={!!routine} onClose={onClose} title={`Körningar – ${routine?.name ?? ""}`} wide>
      {!runs ? (
        <Spinner />
      ) : runs.length === 0 ? (
        <Empty title="Inga körningar än" />
      ) : (
        <div className="divide-y divide-line">
          {runs.map((r) => (
            <Link key={r.id} href={`/?t=${r.thread_id}`} className="flex items-start gap-3 py-2.5 text-sm hover:bg-panel2">
              <Badge tone={r.status === "done" ? "ok" : r.status === "error" ? "danger" : "ember"}>{STATUS_LABEL[r.status]}</Badge>
              <div className="min-w-0 flex-1">
                <div className="text-ink2">
                  {dateTime(r.created_at)} · {r.trigger === "webhook" ? "webhook" : r.trigger === "routine" ? "schema" : r.trigger} · {r.step_count} steg ·{" "}
                  {duration(r.started_at, r.finished_at)}
                </div>
                {(r.summary || r.error) && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{r.error ?? r.summary}</div>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function Page() {
  return (
    <Shell>
      <RoutinesPage />
    </Shell>
  );
}

