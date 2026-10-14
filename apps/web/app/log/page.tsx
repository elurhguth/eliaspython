"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Shell } from "@/components/Shell";
import { toolIcon } from "@/components/Timeline";
import { Badge, BotAvatar, Button, Card, PageHeader, Select, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useCrew } from "@/lib/store";
import { dateTime } from "@/lib/format";

interface Entry {
  id: string;
  ts: string;
  bot_id: string | null;
  bot_name: string | null;
  run_id: string | null;
  thread_id: string | null;
  tool: string;
  action_type: string | null;
  params: Record<string, unknown>;
  outcome: string;
  detail: string | null;
}

const OUTCOME: Record<string, { label: string; tone: "ok" | "danger" | "ember" | "muted" }> = {
  ok: { label: "OK", tone: "ok" },
  error: { label: "Fel", tone: "danger" },
  approval_requested: { label: "Bad om lov", tone: "ember" },
  handoff_requested: { label: "Handoff", tone: "ember" },
};

function LogPage() {
  const crew = useCrew();
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [botId, setBotId] = useState("");
  const [more, setMore] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(
    async (before?: string) => {
      const q = new URLSearchParams({ limit: "100" });
      if (before) q.set("before", before);
      if (botId) q.set("botId", botId);
      const r = await api.get<Entry[]>(`/api/audit?${q}`);
      setMore(r.length === 100);
      setRows((prev) => (before && prev ? [...prev, ...r] : r));
    },
    [botId],
  );
  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <PageHeader
          title="Åtgärdslogg"
          subtitle="Varje åtgärd botarna tagit på datorn och i dina verktyg. Hemligheter maskeras."
          actions={
            <Select value={botId} onChange={(e) => setBotId(e.target.value)} className="w-44">
              <option value="">Alla botar</option>
              {crew.bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          }
        />
        {!rows ? (
          <Spinner />
        ) : (
          <Card className="divide-y divide-line">
            {rows.length === 0 && <div className="p-4 text-sm text-muted">Inga åtgärder ännu.</div>}
            {rows.map((r) => {
              const o = OUTCOME[r.outcome] ?? { label: r.outcome, tone: "muted" as const };
              return (
                <div key={r.id} className="px-3 py-2">
                  <button onClick={() => setOpen(open === r.id ? null : r.id)} className="flex w-full items-center gap-3 text-left text-sm">
                    <span className="w-[120px] shrink-0 text-xs text-faint">{dateTime(r.ts)}</span>
                    <BotAvatar bot={crew.botById(r.bot_id)} size={20} />
                    <span className="text-muted">{toolIcon(r.tool)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink2">{r.tool}</span>
                    {r.action_type && <Badge>{crew.actionTypes[r.action_type] ?? r.action_type}</Badge>}
                    <Badge tone={o.tone}>{o.label}</Badge>
                  </button>
                  {open === r.id && (
                    <div className="ml-[132px] mt-2 space-y-2">
                      <pre className="max-h-60 overflow-auto rounded-lg bg-black/25 p-2 font-mono text-[11.5px] text-ink2">{JSON.stringify(r.params, null, 2)}</pre>
                      {r.detail && <div className="text-xs text-muted">{r.detail}</div>}
                      {r.thread_id && (
                        <Link href={`/?t=${r.thread_id}`} className="text-xs text-ember">
                          Öppna chatten
                        </Link>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        )}
        {rows && more && (
          <div className="mt-4 flex justify-center">
            <Button variant="subtle" onClick={() => load(rows[rows.length - 1]?.id)}>
              Visa äldre
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Shell>
      <LogPage />
    </Shell>
  );
}
