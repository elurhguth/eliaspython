"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Shell } from "@/components/Shell";
import { ApprovalCard } from "@/components/Timeline";
import { Badge, BotAvatar, Card, Empty, PageHeader, Select, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useCrew, useCrewEvent } from "@/lib/store";
import { dateTime } from "@/lib/format";
import type { Approval } from "@/lib/types";

type Policy = { bot_id: string; bot_name: string; action_type: string; decision: "allow" | "deny" };

function ApprovalsPage() {
  const crew = useCrew();
  const [history, setHistory] = useState<(Approval & { bot_name: string })[] | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);

  const load = useCallback(async () => {
    setHistory(await api.get("/api/approvals"));
    setPolicies((await api.get<{ policies: Policy[] }>("/api/policies")).policies);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useCrewEvent((e) => e.type === "approval" && load(), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <PageHeader title="Godkännanden" subtitle="Riskabla åtgärder pausas tills du säger ja. Här ser du vad som väntar, vad du beslutat och dina regler." />

        <h2 className="mb-2 text-sm font-semibold text-ink2">Väntar på dig ({crew.approvals.length})</h2>
        {crew.approvals.length === 0 ? (
          <Card className="mb-8">
            <Empty icon={<ShieldCheck size={26} />} title="Inget väntar" text="Du får en notis när en bot behöver ditt godkännande." />
          </Card>
        ) : (
          <div className="mb-8 space-y-3">
            {crew.approvals.map((a) => (
              <div key={a.id}>
                <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                  <BotAvatar bot={crew.botById(a.bot_id)} size={18} /> {crew.botById(a.bot_id)?.name} · {dateTime(a.created_at)} ·{" "}
                  <Link className="text-ember" href={`/?t=${a.thread_id}`}>
                    öppna chatten
                  </Link>
                </div>
                {a.kind === "handoff" ? (
                  <Card className="p-3 text-sm">
                    {crew.botById(a.bot_id)?.name} behöver att du tar över datorn: {a.summary}.{" "}
                    <Link className="text-ember" href={`/?t=${a.thread_id}`}>
                      Gå till chatten
                    </Link>
                  </Card>
                ) : (
                  <ApprovalCard approval={a} bot={crew.botById(a.bot_id)} compact />
                )}
              </div>
            ))}
          </div>
        )}

        <h2 className="mb-2 text-sm font-semibold text-ink2">Regler</h2>
        <Card className="mb-8 p-1">
          {policies.length === 0 ? (
            <div className="p-3 text-sm text-muted">Inga regler – botarna frågar alltid. ”Tillåt alltid” på ett kort skapar en regel här.</div>
          ) : (
            <div className="divide-y divide-line">
              {policies.map((p) => (
                <div key={p.bot_id + p.action_type} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <BotAvatar bot={crew.botById(p.bot_id)} size={22} />
                  <span className="min-w-0 flex-1 truncate">
                    {p.bot_name}: {crew.actionTypes[p.action_type] ?? p.action_type}
                  </span>
                  <Select
                    className="h-8 w-36 text-xs"
                    value={p.decision}
                    onChange={async (e) => {
                      await api.put("/api/policies", { botId: p.bot_id, actionType: p.action_type, decision: e.target.value === "ask" ? null : e.target.value });
                      load();
                    }}
                  >
                    <option value="ask">Fråga först</option>
                    <option value="allow">Tillåt alltid</option>
                    <option value="deny">Neka alltid</option>
                  </Select>
                </div>
              ))}
            </div>
          )}
        </Card>

        <h2 className="mb-2 text-sm font-semibold text-ink2">Historik</h2>
        {!history ? (
          <Spinner />
        ) : (
          <Card className="divide-y divide-line">
            {history.filter((h) => h.status !== "pending").length === 0 && <div className="p-3 text-sm text-muted">Inget än.</div>}
            {history
              .filter((h) => h.status !== "pending")
              .map((h) => (
                <Link key={h.id} href={`/?t=${h.thread_id}`} className="flex items-start gap-3 px-3 py-2.5 text-sm hover:bg-panel2">
                  <Badge tone={h.status === "allowed" || h.status === "done" ? "ok" : "danger"}>
                    {h.status === "allowed" ? (h.scope === "always" ? "Tillåt alltid" : "Tillåten") : h.status === "done" ? "Övertagen" : "Nekad"}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      {h.bot_name}: {h.summary}
                    </div>
                    <div className="text-xs text-faint">
                      {crew.actionTypes[h.action_type] ?? (h.kind === "handoff" ? "Secure handoff" : h.action_type)} · {dateTime(h.decided_at ?? h.created_at)}
                      {h.note && ` · ”${h.note}”`}
                    </div>
                  </div>
                </Link>
              ))}
          </Card>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Shell>
      <ApprovalsPage />
    </Shell>
  );
}
