"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, MessageSquarePlus, Monitor, MoreHorizontal, Pencil, Plug, Settings2, Trash2, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import { useCrew, useCrewEvent } from "@/lib/store";
import { cx } from "@/lib/format";
import { ACTIVE, type Approval, type Message, type Run, type Step, type Thread } from "@/lib/types";
import { Composer, type Attachment } from "./Composer";
import { ComputerPanel } from "./Computer";
import { ModelPicker } from "./ModelPicker";
import { RunBlock, SystemMessage, UserMessage } from "./Timeline";
import { AvatarStack, BotAvatar, IconButton, Spinner } from "./ui";
import { VoiceMode } from "./Voice";
import { BotEditor } from "./BotEditor";
import type { Bot } from "@/lib/types";

interface ThreadData {
  thread: Thread;
  messages: Message[];
  runs: Run[];
  steps: Step[];
  approvals: Approval[];
}

type Item = { kind: "user"; m: Message } | { kind: "system"; m: Message } | { kind: "run"; key: string; botId: string; runId: string | null; messages: Message[] };

export function ChatView({ threadId }: { threadId: string }) {
  const crew = useCrew();
  const router = useRouter();
  const [data, setData] = useState<ThreadData | null>(null);
  const [error, setError] = useState("");
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [computer, setComputer] = useState(false);
  const [takeover, setTakeover] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const [voice, setVoice] = useState(false);
  const [menu, setMenu] = useState(false);
  const [editBot, setEditBot] = useState<Bot | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const load = useCallback(async () => {
    try {
      setData(await api.get<ThreadData>(`/api/threads/${threadId}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [threadId]);

  useEffect(() => {
    setData(null);
    setStreaming({});
    setTakeover(false);
    stick.current = true;
    load();
  }, [load]);

  // Reload after reconnects so nothing is missed.
  useEffect(() => {
    if (crew.connected) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crew.connected]);

  useCrewEvent(
    (e) => {
      if (e.type === "thread" && e.thread.id === threadId) {
        if (e.thread.deleted) router.push("/");
        else setData((d) => (d ? { ...d, thread: { ...d.thread, ...e.thread } } : d));
        return;
      }
      if (!("threadId" in e) || e.threadId !== threadId) return;
      if (e.type === "delta") {
        setStreaming((s) => ({ ...s, [e.runId]: (s[e.runId] ?? "") + e.text }));
        return;
      }
      setData((d) => {
        if (!d) return d;
        if (e.type === "message") {
          if (d.messages.some((m) => m.id === e.message.id)) return d;
          return { ...d, messages: [...d.messages, e.message] };
        }
        if (e.type === "run") {
          const others = d.runs.filter((r) => r.id !== e.run.id);
          return { ...d, runs: [e.run, ...others] };
        }
        if (e.type === "step") {
          const others = d.steps.filter((s) => s.id !== e.step.id);
          return { ...d, steps: [...others, e.step].sort((a, b) => a.created_at.localeCompare(b.created_at)) };
        }
        if (e.type === "approval") {
          const others = d.approvals.filter((a) => a.id !== e.approval.id);
          return { ...d, approvals: [e.approval, ...others] };
        }
        return d;
      });
      if (e.type === "message" && e.message.run_id && e.message.role === "assistant") {
        setStreaming((s) => {
          const n = { ...s };
          delete n[e.message.run_id!];
          return n;
        });
      }
      if (e.type === "run" && !ACTIVE.includes(e.run.status)) {
        setStreaming((s) => {
          const n = { ...s };
          delete n[e.run.id];
          return n;
        });
      }
    },
    [threadId],
  );

  // Auto-scroll when at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [data?.messages.length, streaming, data?.approvals, data?.steps.length]);

  const thread = data?.thread;
  const members = useMemo(() => (thread?.bot_ids ?? []).map((id) => crew.botById(id)).filter(Boolean) as NonNullable<ReturnType<typeof crew.botById>>[], [thread, crew]);
  const runsById = useMemo(() => new Map((data?.runs ?? []).map((r) => [r.id, r])), [data?.runs]);
  const stepsByCall = useMemo(() => new Map((data?.steps ?? []).filter((s) => s.tool_call_id).map((s) => [s.tool_call_id!, s])), [data?.steps]);
  const activeRuns = (data?.runs ?? []).filter((r) => ACTIVE.includes(r.status));
  const handoff = (data?.approvals ?? []).find((a) => a.kind === "handoff" && a.status === "pending") ?? null;
  const botsBySlug = useMemo(() => new Map(crew.bots.map((b) => [b.slug, b])), [crew.bots]);

  useEffect(() => {
    if (handoff) setComputer(true);
  }, [handoff]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const m of data?.messages ?? []) {
      if (m.author_type === "user") out.push({ kind: "user", m });
      else if (m.author_type === "system") out.push({ kind: "system", m });
      else {
        const last = out[out.length - 1];
        if (last?.kind === "run" && last.botId === m.bot_id && last.runId === m.run_id) last.messages.push(m);
        else out.push({ kind: "run", key: m.id, botId: m.bot_id!, runId: m.run_id, messages: [m] });
      }
    }
    // Active runs that have not produced a message yet.
    for (const r of activeRuns) {
      if (!out.some((i) => i.kind === "run" && i.runId === r.id)) out.push({ kind: "run", key: `run-${r.id}`, botId: r.bot_id, runId: r.id, messages: [] });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.messages, data?.runs]);

  // Target bot for the model picker: the single bot, or the lead in a group.
  const target = members.length === 1 ? members[0] : (members.find((b) => b.is_lead) ?? members[0]);
  const override = target ? thread?.model_override?.[target.id] : undefined;

  async function send(text: string, attachments: Attachment[]) {
    stick.current = true;
    await api.post(`/api/threads/${threadId}/messages`, { text, attachmentIds: attachments.map((a) => a.id) });
  }

  async function stop() {
    await Promise.all(activeRuns.map((r) => api.post(`/api/runs/${r.id}/cancel`)));
  }

  const lastReply = useMemo(() => {
    const msgs = (data?.messages ?? []).filter((m) => m.author_type === "bot" && m.role === "assistant");
    for (let i = msgs.length - 1; i >= 0; i--) {
      const t = msgs[i].content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
      if (t) return { id: msgs[i].id, text: t };
    }
    return null;
  }, [data?.messages]);

  if (error) return <div className="flex flex-1 items-center justify-center text-sm text-danger">{error}</div>;
  if (!data || !thread) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <AvatarStack bots={members} size={26} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{thread.title || (members.length > 1 ? "Gruppchatt" : members[0]?.name)}</div>
            <div className="truncate text-xs text-muted">
              {members.map((b) => b.name).join(", ")}
              {thread.kind === "routine" && " · routine"}
            </div>
          </div>
          <button
            onClick={() => setComputer((c) => !c)}
            className={cx(
              "flex h-9 items-center gap-2 rounded-xl px-3 text-sm transition-colors",
              computer ? "bg-raise text-ink" : "text-ink2 hover:bg-raise",
              handoff && "text-ember",
            )}
          >
            <Monitor size={16} />
            <span className="hidden sm:inline">Datorn</span>
            {activeRuns.some((r) => r.status === "running") && <span className="pulse-dot h-2 w-2 rounded-full bg-ember" />}
          </button>
          <div className="relative">
            <IconButton label="Mer" onClick={() => setMenu((m) => !m)}>
              <MoreHorizontal size={18} />
            </IconButton>
            {menu && <ThreadMenu thread={thread} onClose={() => setMenu(false)} onEditBot={setEditBot} />}
          </div>
        </header>

        <div
          ref={scroller}
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
        >
          <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
            {items.length === 0 && (
              <div className="py-16 text-center text-sm text-muted">
                <div className="mb-3 flex justify-center">
                  <AvatarStack bots={members} size={40} />
                </div>
                Skriv en uppgift så sätter {members.map((m) => m.name).join(" och ")} igång.
              </div>
            )}
            {items.map((it) =>
              it.kind === "user" ? (
                <UserMessage key={it.m.id} m={it.m} onImage={setZoom} />
              ) : it.kind === "system" ? (
                <SystemMessage key={it.m.id} m={it.m} />
              ) : (
                <RunBlock
                  key={it.key}
                  bot={crew.botById(it.botId)}
                  run={it.runId ? runsById.get(it.runId) : undefined}
                  messages={it.messages}
                  steps={stepsByCall}
                  streaming={it.runId ? streaming[it.runId] : undefined}
                  approvals={data.approvals}
                  onImage={setZoom}
                  onTakeover={() => {
                    setComputer(true);
                    setTakeover(true);
                  }}
                  botsBySlug={botsBySlug}
                />
              ),
            )}
          </div>
        </div>

        <div className="safe-bottom mx-auto w-full max-w-3xl px-3 pt-1 sm:px-4">
          <Composer
            onSend={send}
            ensureThread={async () => threadId}
            mentionBots={crew.bots}
            placeholder={members.length > 1 ? "Skriv till gruppen – @nämn en bot för att rikta dig till den" : `Skriv till ${members[0]?.name ?? "boten"}…`}
            busy={activeRuns.length > 0}
            onStop={stop}
            onVoice={() => setVoice(true)}
            modelSlot={
              target && (
                <ModelPicker
                  compact
                  up
                  provider={override?.provider ?? target.provider}
                  model={override?.model ?? target.model}
                  onChange={(provider, model) =>
                    api.patch(`/api/threads/${threadId}`, { modelOverride: { botId: target.id, provider, model } }).then(load)
                  }
                />
              )
            }
          />
          <div className="py-1.5 text-center text-[11px] text-faint">Botarna jobbar vidare även om du stänger appen. Riskabla åtgärder kräver ditt godkännande.</div>
        </div>
      </div>

      {computer && (
        <>
          <div className="hidden w-[min(46vw,640px)] shrink-0 border-l border-line lg:flex lg:flex-col">
            <ComputerPanel steps={data.steps} handoff={handoff} bot={target} onClose={() => setComputer(false)} takeover={takeover} setTakeover={setTakeover} />
          </div>
          <div className="safe-top fixed inset-0 z-40 flex flex-col bg-panel lg:hidden">
            <ComputerPanel steps={data.steps} handoff={handoff} bot={target} onClose={() => setComputer(false)} takeover={takeover} setTakeover={setTakeover} />
          </div>
        </>
      )}

      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/files/${zoom}`} alt="" className="max-h-full max-w-full rounded-xl" />
        </div>
      )}

      <BotEditor bot={editBot} open={!!editBot} onClose={() => setEditBot(null)} />

      {voice && (
        <VoiceMode
          bot={target}
          busy={activeRuns.length > 0}
          lastReply={lastReply}
          onSend={(t) => send(t, [])}
          onClose={() => setVoice(false)}
        />
      )}
    </div>
  );
}

function ThreadMenu({ thread, onClose, onEditBot }: { thread: Thread; onClose: () => void; onEditBot: (b: Bot) => void }) {
  const crew = useCrew();
  const router = useRouter();
  const notMembers = crew.bots.filter((b) => !thread.bot_ids.includes(b.id));
  const members = thread.bot_ids.map((id) => crew.botById(id)).filter(Boolean) as Bot[];
  useEffect(() => {
    const t = setTimeout(() => document.addEventListener("click", onClose, { once: true }), 0);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className="absolute right-0 top-full z-30 mt-2 w-60 rounded-2xl border border-line bg-panel p-1.5 shadow-2xl">
      <MenuItem
        icon={<Pencil size={14} />}
        label="Byt namn"
        onClick={async () => {
          const title = prompt("Nytt namn på chatten", thread.title);
          if (title !== null) await api.patch(`/api/threads/${thread.id}`, { title });
        }}
      />
      {members.map((b) => (
        <MenuItem key={`new-${b.id}`} icon={<MessageSquarePlus size={14} />} label={`Ny chatt med ${b.name}`} onClick={() => router.push(`/?bot=${b.id}&new=1`)} />
      ))}
      {members.map((b) => (
        <MenuItem key={`edit-${b.id}`} icon={<Settings2 size={14} />} label={`Redigera ${b.name}`} onClick={() => onEditBot(b)} />
      ))}
      {notMembers.length > 0 && <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Lägg till i chatten</div>}
      {notMembers.map((b) => (
        <MenuItem key={b.id} icon={<UserPlus size={14} />} label={b.name} onClick={() => api.patch(`/api/threads/${thread.id}`, { addBotId: b.id })} extra={<BotAvatar bot={b} size={18} />} />
      ))}
      <MenuItem icon={<Plug size={14} />} label="Koppla källa / verktyg (MCP)" onClick={() => router.push("/settings#mcp")} />
      <div className="my-1 border-t border-line" />
      <MenuItem icon={<Archive size={14} />} label="Arkivera" onClick={async () => {
        await api.patch(`/api/threads/${thread.id}`, { archived: true });
        router.push("/");
      }} />
      <MenuItem
        icon={<Trash2 size={14} />}
        label="Radera chatten"
        danger
        onClick={async () => {
          if (confirm("Radera chatten och dess historik? Minnen och filer på datorn finns kvar.")) {
            await api.del(`/api/threads/${thread.id}`);
            router.push("/");
          }
        }}
      />
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger, extra }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; extra?: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-raise", danger ? "text-danger" : "text-ink2")}>
      <span className="text-muted">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {extra}
    </button>
  );
}
