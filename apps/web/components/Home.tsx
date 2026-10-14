"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { api } from "@/lib/api";
import { useCrew } from "@/lib/store";
import { cx } from "@/lib/format";
import type { Thread } from "@/lib/types";
import { Composer, type Attachment } from "./Composer";
import { ModelPicker } from "./ModelPicker";
import { BotAvatar, Logo } from "./ui";

const SUGGESTIONS = [
  "Gör en research om de bästa elcyklarna under 20 000 kr och spara en jämförelse",
  "Gå igenom min inkorg och sammanfatta det viktigaste",
  "Bevaka en sajt och säg till när något nytt dyker upp",
  "Kom ihåg att jag föredrar korta svar på svenska",
];

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "God natt";
  if (h < 10) return "God morgon";
  if (h < 17) return "Hej";
  return "God kväll";
}

export function Home({ preselectBotId }: { preselectBotId?: string | null }) {
  const crew = useCrew();
  const router = useRouter();
  const lead = crew.bots.find((b) => b.is_lead) ?? crew.bots[0];
  const [selected, setSelected] = useState<string[]>(preselectBotId ? [preselectBotId] : lead ? [lead.id] : []);
  const threadRef = useRef<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (preselectBotId) setSelected([preselectBotId]);
    threadRef.current = null;
  }, [preselectBotId]);

  const single = selected.length === 1 ? crew.botById(selected[0]) : undefined;

  async function ensureThread() {
    if (threadRef.current) return threadRef.current;
    if (!selected.length) throw new Error("Välj minst en bot");
    const t = await api.post<Thread>("/api/threads", { botIds: selected });
    crew.upsertThread(t);
    threadRef.current = t.id;
    return t.id;
  }

  async function send(text: string, attachments: Attachment[]) {
    const id = await ensureThread();
    await api.post(`/api/threads/${id}/messages`, { text, attachmentIds: attachments.map((a) => a.id) });
    router.push(`/?t=${id}`);
  }

  const toggle = (id: string) => {
    threadRef.current = null;
    setSelected((s) => (s.includes(id) ? (s.length > 1 ? s.filter((x) => x !== id) : s) : [...s, id]));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-4 py-10">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size={52} />
          <h1 className="mt-5 text-2xl font-semibold tracking-tight sm:text-[28px]">
            {greeting()}, {crew.user.username}
          </h1>
          <p className="mt-2 text-sm text-muted">Vad ska teamet göra? De jobbar vidare i bakgrunden och hör av sig när de behöver dig.</p>
        </div>

        <div className="mb-3 flex flex-wrap justify-center gap-1.5">
          {crew.bots.map((b) => {
            const on = selected.includes(b.id);
            return (
              <button
                key={b.id}
                onClick={() => toggle(b.id)}
                className={cx(
                  "flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm transition-colors",
                  on ? "border-ember/50 bg-ember/10 text-ink" : "border-line text-ink2 hover:border-line2",
                )}
              >
                <BotAvatar bot={b} size={24} />
                {b.name}
                {on && <Check size={13} className="text-ember" />}
              </button>
            );
          })}
        </div>

        <Composer
          key={selected.join(",")}
          big
          autoFocus
          onSend={send}
          ensureThread={ensureThread}
          mentionBots={crew.bots}
          placeholder={selected.length > 1 ? "Ge gruppen en uppgift…" : `Vad ska ${single?.name ?? "boten"} göra?`}
          modelSlot={
            single && (
              <ModelPicker
                compact
                provider={single.provider}
                model={single.model}
                onChange={async (provider, model) => {
                  await api.patch(`/api/bots/${single.id}`, { provider, model });
                  await crew.refreshBots();
                }}
              />
            )
          }
        />
        {draft === "" && (
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s, []).catch(() => setDraft(s))}
                className="rounded-2xl border border-line bg-panel/50 px-4 py-3 text-left text-[13px] leading-snug text-ink2 transition-colors hover:border-line2 hover:bg-panel"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {!crew.workstation.ok && (
          <div className="mt-6 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            Datorn (workstation) svarar inte. Kontrollera att containern körs: <code>docker compose ps</code>
          </div>
        )}
        {crew.models.providers.every((p) => !p.configured || p.id === "demo") && (
          <div className="mt-6 rounded-2xl border border-line bg-panel px-4 py-3 text-sm text-ink2">
            <b>Demoläge:</b> ingen AI-nyckel är inlagd ännu. Lägg in <code>ANTHROPIC_API_KEY</code> och/eller <code>XAI_API_KEY</code> i <code>.env</code> och
            starta om. Du kan ändå testa datorn med t.ex. <i>”öppna example.com och ta en skärmdump”</i>.
          </div>
        )}
      </div>
    </div>
  );
}
