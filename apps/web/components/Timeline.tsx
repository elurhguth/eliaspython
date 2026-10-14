"use client";

import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Clock,
  FileText,
  Globe,
  Hand,
  Loader2,
  MonitorPlay,
  Puzzle,
  Search,
  ShieldAlert,
  Terminal,
  Users,
  CalendarClock,
  MousePointerClick,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, fileUrl } from "@/lib/api";
import { bytes, clock, cx, duration, STATUS_LABEL } from "@/lib/format";
import type { Approval, Block, Bot, Message, Run, Step } from "@/lib/types";
import { Markdown } from "./Markdown";
import { BotAvatar, Button, Input } from "./ui";

export function toolIcon(name: string, size = 14) {
  if (name.startsWith("browser_click") || name.startsWith("browser_type") || name.startsWith("browser_press") || name.startsWith("browser_select"))
    return <MousePointerClick size={size} />;
  if (name.startsWith("browser_")) return <Globe size={size} />;
  if (name === "request_takeover") return <Hand size={size} />;
  if (name === "shell_run") return <Terminal size={size} />;
  if (name.startsWith("file_")) return <FileText size={size} />;
  if (name.startsWith("web_")) return <Search size={size} />;
  if (name.startsWith("memory_") || name === "skill_save" || name === "search_history") return <Brain size={size} />;
  if (name === "delegate") return <Users size={size} />;
  if (name.startsWith("routine_")) return <CalendarClock size={size} />;
  if (name.startsWith("mcp__")) return <Puzzle size={size} />;
  return <Puzzle size={size} />;
}

function StatusIcon({ status }: { status: Step["status"] }) {
  if (status === "running") return <Loader2 size={13} className="animate-spin text-ember" />;
  if (status === "waiting") return <Clock size={13} className="text-ember" />;
  if (status === "error") return <AlertTriangle size={13} className="text-danger" />;
  if (status === "cancelled") return <CircleSlash size={13} className="text-faint" />;
  return <Check size={13} className="text-ok" />;
}

export function StepRow({ step, call, onImage }: { step?: Step; call: Extract<Block, { type: "tool_call" }>; onImage: (ref: string) => void }) {
  const [open, setOpen] = useState(false);
  const title = step?.title ?? call.name;
  const status = step?.status ?? "running";
  const result = step?.result;
  return (
    <div className="group">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] text-ink2 transition-colors hover:bg-panel2"
      >
        <span className="text-muted">{toolIcon(call.name)}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {step?.screenshot && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onImage(step.screenshot!);
            }}
            className="hidden shrink-0 overflow-hidden rounded border border-line sm:block"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl(step.screenshot)} alt="" className="h-6 w-10 object-cover object-top" loading="lazy" />
          </span>
        )}
        <StatusIcon status={status} />
        <span className="text-faint">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
      </button>
      {open && (
        <div className="mb-2 ml-6 mt-1 space-y-2">
          <pre className="max-h-40 overflow-auto rounded-lg border border-line bg-[#0e1013] p-2 font-mono text-[11.5px] text-ink2">
            {JSON.stringify(step?.detail?.input ?? call.input, null, 2)}
          </pre>
          {result && (
            <pre
              className={cx(
                "max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border bg-[#0e1013] p-2 font-mono text-[11.5px]",
                result.isError ? "border-danger/40 text-danger" : "border-line text-ink2",
              )}
            >
              {result.content.length > 6000 ? result.content.slice(0, 6000) + "\n…" : result.content}
            </pre>
          )}
          {step?.screenshot && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={fileUrl(step.screenshot)}
              alt="Skärmdump"
              onClick={() => onImage(step.screenshot!)}
              className="max-h-64 cursor-zoom-in rounded-lg border border-line"
              loading="lazy"
            />
          )}
        </div>
      )}
    </div>
  );
}

function StepGroup({ calls, steps, running, onImage }: { calls: Extract<Block, { type: "tool_call" }>[]; steps: Map<string, Step>; running: boolean; onImage: (r: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const show = expanded || running ? calls : calls.length > 3 ? calls.slice(-2) : calls;
  const hidden = calls.length - show.length;
  return (
    <div className="my-1.5 rounded-xl border border-line/70 bg-panel/60 px-1.5 py-1">
      {hidden > 0 && (
        <button onClick={() => setExpanded(true)} className="flex w-full items-center gap-2 px-1.5 py-1 text-left text-xs text-muted hover:text-ink">
          <ChevronRight size={13} /> {hidden} tidigare steg
        </button>
      )}
      {show.map((c) => (
        <StepRow key={c.id} call={c} step={steps.get(c.id)} onImage={onImage} />
      ))}
    </div>
  );
}

function Attachments({ content, onImage }: { content: Block[]; onImage: (ref: string) => void }) {
  const files = content.filter((b) => b.type === "file") as Extract<Block, { type: "file" }>[];
  const images = content.filter((b) => b.type === "image") as Extract<Block, { type: "image" }>[];
  if (!files.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {files.map((f) => {
        const img = images.find((i) => i.name === f.name);
        return img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={f.attachmentId} src={fileUrl(img.ref)} alt={f.name} onClick={() => onImage(img.ref)} className="max-h-40 cursor-zoom-in rounded-xl border border-line" />
        ) : (
          <a
            key={f.attachmentId}
            href={`/api/workstation/download?path=${encodeURIComponent(f.path)}`}
            className="flex items-center gap-2 rounded-xl border border-line bg-raise px-3 py-2 text-xs hover:border-line2"
          >
            <FileText size={14} className="text-muted" />
            <span className="max-w-[200px] truncate">{f.name}</span>
            <span className="text-faint">{bytes(f.size)}</span>
          </a>
        );
      })}
    </div>
  );
}

export function UserMessage({ m, onImage }: { m: Message; onImage: (ref: string) => void }) {
  const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-[20px] rounded-br-md bg-raise px-4 py-2.5 text-[15px] leading-relaxed">
        {text && <div className="whitespace-pre-wrap break-words">{text}</div>}
        <Attachments content={m.content} onImage={onImage} />
      </div>
    </div>
  );
}

export function SystemMessage({ m }: { m: Message }) {
  const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  return (
    <div className="mx-auto max-w-[90%] rounded-2xl border border-dashed border-line px-4 py-2.5 text-sm text-ink2">
      <Markdown text={text} />
    </div>
  );
}

/** One bot "turn": all messages of a run, with steps, streaming text, approvals and status. */
export function RunBlock({
  bot,
  run,
  messages,
  steps,
  streaming,
  approvals,
  onImage,
  onTakeover,
  botsBySlug,
}: {
  bot?: Bot;
  run?: Run;
  messages: Message[];
  steps: Map<string, Step>;
  streaming?: string;
  approvals: Approval[];
  onImage: (ref: string) => void;
  onTakeover: (a: Approval) => void;
  botsBySlug: Map<string, Bot>;
}) {
  const active = run && ["queued", "running", "waiting_approval", "waiting_handoff"].includes(run.status);
  const parts: ReactNode[] = [];
  let pendingCalls: Extract<Block, { type: "tool_call" }>[] = [];
  const flushCalls = (key: string, last: boolean) => {
    if (!pendingCalls.length) return;
    parts.push(<StepGroup key={`g-${key}`} calls={pendingCalls} steps={steps} running={!!active && last} onImage={onImage} />);
    pendingCalls = [];
  };
  messages.forEach((m, i) => {
    if (m.role === "tool") return;
    const text = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
    if (text) {
      flushCalls(m.id, false);
      if (m.role === "note") {
        const target = text.match(/^@([\w-]+)/)?.[1];
        const tb = target ? botsBySlug.get(target) : undefined;
        parts.push(
          <div key={m.id} className="my-1.5 flex items-start gap-2 rounded-xl border border-line bg-panel/60 px-3 py-2 text-sm text-ink2">
            <Users size={14} className="mt-1 shrink-0 text-muted" />
            <div className="min-w-0">
              <div className="mb-0.5 text-xs text-muted">Lämnade över till {tb?.name ?? `@${target}`}</div>
              <Markdown text={text.replace(/^@[\w-]+\s*/, "")} />
            </div>
          </div>,
        );
      } else parts.push(<Markdown key={m.id} text={text} className="text-[15px]" />);
    }
    for (const b of m.content) if (b.type === "tool_call") pendingCalls.push(b);
    if (i === messages.length - 1) flushCalls(m.id, true);
  });
  flushCalls("end", true);

  const pending = approvals.filter((a) => a.status === "pending" && a.run_id === run?.id);
  const lastTime = messages[messages.length - 1]?.created_at ?? run?.created_at;

  return (
    <div className="flex gap-3">
      <div className="pt-0.5">
        <BotAvatar bot={bot} size={30} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <span className="font-semibold">{bot?.name ?? "Bot"}</span>
          {lastTime && <span className="text-xs text-faint">{clock(lastTime)}</span>}
          {run && run.trigger !== "chat" && (
            <span className="text-xs text-faint">
              · {run.trigger === "routine" ? "routine" : run.trigger === "webhook" ? "webhook" : run.trigger === "delegation" ? "överlämning" : run.trigger}
            </span>
          )}
        </div>
        <div className="space-y-1">{parts}</div>
        {streaming && <Markdown text={streaming} className="stream-caret text-[15px]" />}
        {pending.map((a) => (
          <ApprovalCard key={a.id} approval={a} bot={bot} onTakeover={onTakeover} />
        ))}
        {active && !streaming && !pending.length && (
          <div className="mt-1.5 flex items-center gap-2 text-sm text-muted">
            <span className="pulse-dot h-2 w-2 rounded-full bg-ember" />
            {run!.status === "queued" ? "I kö…" : STATUS_LABEL[run!.status]}
            {run!.started_at && <span className="text-faint">· {duration(run!.started_at, null)}</span>}
          </div>
        )}
        {run?.status === "error" && run.error && !messages.some((m) => m.content.some((b) => b.type === "text" && b.text.startsWith("⚠️"))) && (
          <div className="mt-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{run.error}</div>
        )}
        {run?.status === "cancelled" && <div className="mt-1 text-xs text-faint">Avbruten</div>}
      </div>
    </div>
  );
}

export function ApprovalCard({ approval, bot, onTakeover, compact }: { approval: Approval; bot?: Bot; onTakeover?: (a: Approval) => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const decide = async (decision: "allow_once" | "allow_always" | "deny") => {
    setBusy(true);
    try {
      await api.post(`/api/approvals/${approval.id}/decide`, { decision, note: note || undefined });
    } finally {
      setBusy(false);
    }
  };
  if (approval.kind === "handoff") {
    return (
      <div className="mt-2 rounded-2xl border border-ember/40 bg-ember/[0.07] p-3.5">
        <div className="flex items-start gap-2.5">
          <Hand size={18} className="mt-0.5 shrink-0 text-ember" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{bot?.name ?? "Boten"} behöver att du tar över datorn</div>
            <div className="mt-0.5 text-sm text-ink2">{approval.summary}</div>
            <div className="mt-1 text-xs text-muted">Boten ser inte vad du skriver. Lämna tillbaka när du är klar.</div>
          </div>
        </div>
        {onTakeover && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={() => onTakeover(approval)}>
              <MonitorPlay size={14} /> Ta över datorn
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => api.post(`/api/approvals/${approval.id}/handoff`, { done: false, note: "Användaren avböjde" })}
            >
              Avböj
            </Button>
          </div>
        )}
      </div>
    );
  }
  const input = approval.detail?.input ?? {};
  const preview = Object.entries(input)
    .filter(([k]) => k !== "intent")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  return (
    <div className={cx("rounded-2xl border border-ember/40 bg-ember/[0.07] p-3.5", !compact && "mt-2")}>
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-ember" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {bot?.name ?? "Boten"} vill: {approval.summary}
          </div>
          {preview && <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg bg-black/25 p-2 font-mono text-[11.5px] text-ink2">{preview}</pre>}
          {approval.detail?.reason && <div className="mt-1 text-xs text-muted">Varför jag frågar: {approval.detail.reason}</div>}
        </div>
      </div>
      {showNote && (
        <div className="mt-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Meddelande till boten (valfritt)" />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => decide("allow_once")}>
          Tillåt en gång
        </Button>
        <Button variant="subtle" size="sm" disabled={busy} onClick={() => decide("deny")}>
          Neka
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => decide("allow_always")} title="Tillåt alltid den här typen av åtgärd för den här boten">
          Tillåt alltid
        </Button>
        {!showNote && (
          <button onClick={() => setShowNote(true)} className="ml-auto text-xs text-muted hover:text-ink">
            + meddelande
          </button>
        )}
      </div>
    </div>
  );
}
