"use client";

import { ArrowUp, AudioLines, FileText, Loader2, Paperclip, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { bytes, cx } from "@/lib/format";
import type { Bot } from "@/lib/types";
import { BotAvatar } from "./ui";
import { MicButton } from "./Voice";

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  path: string;
}

export function Composer({
  onSend,
  ensureThread,
  placeholder,
  mentionBots,
  modelSlot,
  busy,
  onStop,
  onVoice,
  autoFocus,
  big,
}: {
  onSend: (text: string, attachments: Attachment[]) => Promise<void> | void;
  ensureThread: () => Promise<string>;
  placeholder?: string;
  mentionBots: Bot[];
  modelSlot?: ReactNode;
  busy?: boolean;
  onStop?: () => void;
  onVoice?: () => void;
  autoFocus?: boolean;
  big?: boolean;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dictationBase = useRef("");

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  }, [text]);

  const candidates = mention
    ? mentionBots.filter((b) => b.slug.startsWith(mention.query.toLowerCase()) || b.name.toLowerCase().startsWith(mention.query.toLowerCase())).slice(0, 6)
    : [];

  function updateMention(value: string, caret: number) {
    const before = value.slice(0, caret);
    const m = before.match(/(^|\s)@([\w-]*)$/);
    if (m) {
      setMention({ query: m[2], start: caret - m[2].length - 1 });
      setMentionIdx(0);
    } else setMention(null);
  }

  function pickMention(b: Bot) {
    if (!mention) return;
    const caret = ta.current?.selectionStart ?? text.length;
    const next = text.slice(0, mention.start) + `@${b.slug} ` + text.slice(caret);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => ta.current?.focus());
  }

  async function addFiles(list: FileList | File[]) {
    setError("");
    const arr = Array.from(list);
    if (!arr.length) return;
    let threadId: string;
    try {
      threadId = await ensureThread();
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setUploading((n) => n + arr.length);
    for (const f of arr) {
      try {
        const att = await api.upload<Attachment>(`/api/threads/${threadId}/uploads`, f);
        setFiles((prev) => [...prev, att]);
      } catch (e) {
        setError(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function submit() {
    const t = text.trim();
    if ((!t && !files.length) || sending || uploading) return;
    setSending(true);
    setError("");
    try {
      await onSend(t, files);
      setText("");
      setFiles([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="relative"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
      }}
    >
      {candidates.length > 0 && (
        <div className="absolute bottom-full left-2 z-20 mb-2 w-64 rounded-2xl border border-line bg-panel p-1.5 shadow-2xl">
          {candidates.map((b, i) => (
            <button
              key={b.id}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(b);
              }}
              className={cx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm", i === mentionIdx ? "bg-raise" : "hover:bg-raise")}
            >
              <BotAvatar bot={b} size={22} />
              <span className="font-medium">{b.name}</span>
              <span className="text-xs text-muted">@{b.slug}</span>
            </button>
          ))}
        </div>
      )}
      <div className={cx("rounded-[22px] border border-line2 bg-panel2 shadow-lg shadow-black/20 transition-colors focus-within:border-[#3d434b]")}>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {files.map((f) => (
              <span key={f.id} className="flex items-center gap-2 rounded-xl border border-line bg-raise px-2.5 py-1.5 text-xs">
                <FileText size={14} className="text-muted" />
                <span className="max-w-[160px] truncate">{f.filename}</span>
                <span className="text-faint">{bytes(f.size)}</span>
                <button onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))} className="text-muted hover:text-ink" aria-label="Ta bort">
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          placeholder={placeholder ?? "Skriv en uppgift…"}
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onPaste={(e) => {
            const items = Array.from(e.clipboardData.files ?? []);
            if (items.length) {
              e.preventDefault();
              addFiles(items);
            }
          }}
          onKeyDown={(e) => {
            if (candidates.length) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIdx((i) => (i + 1) % candidates.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIdx((i) => (i - 1 + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(candidates[mentionIdx]);
                return;
              }
              if (e.key === "Escape") {
                setMention(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
              e.preventDefault();
              submit();
            }
          }}
          className={cx(
            "block w-full resize-none bg-transparent px-4 text-[15px] leading-6 text-ink placeholder:text-faint outline-none",
            big ? "min-h-[84px] pt-4" : "min-h-[52px] pt-3.5",
          )}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-muted hover:bg-raise hover:text-ink"
            aria-label="Bifoga fil"
            title="Bifoga fil"
          >
            {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
          </button>
          <MicButton
            onText={(t, final) => {
              if (!dictationBase.current && !final) dictationBase.current = text ? text + " " : "";
              setText(dictationBase.current + t);
              if (final) dictationBase.current = "";
            }}
          />
          {onVoice && (
            <button
              type="button"
              onClick={onVoice}
              className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-muted hover:bg-raise hover:text-ink"
              aria-label="Röstläge"
              title="Röstläge (prata med boten)"
            >
              <AudioLines size={16} />
            </button>
          )}
          <div className="ml-auto flex items-center gap-1">
            {modelSlot}
            {busy && onStop && !text.trim() ? (
              <button
                type="button"
                onClick={onStop}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-raise text-ink hover:bg-line2"
                aria-label="Stoppa"
                title="Stoppa"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={(!text.trim() && !files.length) || sending || uploading > 0}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-ink text-bg transition-opacity disabled:opacity-25"
                aria-label="Skicka"
              >
                {sending ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={18} strokeWidth={2.5} />}
              </button>
            )}
          </div>
        </div>
      </div>
      {error && <div className="mt-2 px-2 text-sm text-danger">{error}</div>}
    </div>
  );
}
