"use client";

import { Mic, MicOff, Volume2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { listen, speak, stopSpeaking, sttSupported, ttsSupported, voices, type BotVoice } from "@/lib/voice";
import { cx } from "@/lib/format";
import type { Bot } from "@/lib/types";
import { BotAvatar, Button, Select, Toggle } from "./ui";

export function VoiceSettings({ value, onChange }: { value: BotVoice; onChange: (v: BotVoice) => void }) {
  const [list, setList] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!ttsSupported()) return;
    const load = () => setList(voices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  if (!ttsSupported()) return null;
  const sorted = [...list].sort((a, b) => Number(b.lang.startsWith("sv")) - Number(a.lang.startsWith("sv")) || a.name.localeCompare(b.name));
  return (
    <div>
      <div className="mb-1 text-[13px] font-medium text-ink2">Röst</div>
      <div className="grid gap-2 sm:grid-cols-[1fr_140px_auto]">
        <Select value={value.voiceURI ?? ""} onChange={(e) => onChange({ ...value, voiceURI: e.target.value || undefined })}>
          <option value="">Standard (svensk om möjligt)</option>
          {sorted.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name} ({v.lang})
            </option>
          ))}
        </Select>
        <Select value={String(value.rate ?? 1.05)} onChange={(e) => onChange({ ...value, rate: Number(e.target.value) })}>
          {[0.85, 0.95, 1.05, 1.15, 1.3].map((r) => (
            <option key={r} value={r}>
              Tempo {r}×
            </option>
          ))}
        </Select>
        <Button variant="subtle" onClick={() => speak("Hej! Så här låter jag.", value)}>
          <Volume2 size={15} /> Testa
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2 text-sm text-ink2">
        <Toggle checked={!!value.autoSpeak} onChange={(v) => onChange({ ...value, autoSpeak: v })} /> Läs upp svar automatiskt i röstläge
      </div>
      <div className="mt-1 text-xs text-muted">Röster kommer från din enhet/webbläsare (ingen extra kostnad).</div>
    </div>
  );
}

/** Dictation button for the composer. */
export function MicButton({ onText, disabled }: { onText: (t: string, final: boolean) => void; disabled?: boolean }) {
  const [on, setOn] = useState(false);
  const rec = useRef<ReturnType<typeof listen>>(null);
  if (!sttSupported()) return null;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (on) {
          rec.current?.stop();
          return;
        }
        rec.current = listen({
          continuous: true,
          onPartial: (t) => onText(t, false),
          onFinal: (t) => onText(t, true),
          onEnd: () => setOn(false),
          onError: () => setOn(false),
        });
        setOn(!!rec.current);
      }}
      className={cx(
        "inline-flex h-8 w-8 items-center justify-center rounded-xl transition-colors",
        on ? "bg-danger/20 text-danger" : "text-muted hover:bg-raise hover:text-ink",
      )}
      aria-label={on ? "Stoppa diktering" : "Diktera"}
      title={on ? "Stoppa diktering" : "Diktera"}
    >
      {on ? <MicOff size={16} /> : <Mic size={16} />}
    </button>
  );
}

/**
 * Hands-free voice mode: listen → send → wait for the bot's answer → read it out → listen again.
 * `lastReply` is the latest finished bot text in the thread (changes trigger speech).
 */
export function VoiceMode({
  bot,
  onSend,
  lastReply,
  busy,
  onClose,
}: {
  bot?: Bot;
  onSend: (text: string) => Promise<void>;
  lastReply: { id: string; text: string } | null;
  busy: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<"listening" | "thinking" | "speaking" | "idle">("idle");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const rec = useRef<ReturnType<typeof listen>>(null);
  const spokenId = useRef<string | null>(lastReply?.id ?? null);
  const active = useRef(true);

  const startListening = () => {
    if (!active.current) return;
    setPartial("");
    setState("listening");
    rec.current = listen({
      onPartial: setPartial,
      onFinal: async (t) => {
        setState("thinking");
        await onSend(t);
      },
      onEnd: () => setState((s) => (s === "listening" ? "idle" : s)),
      onError: (e) => {
        if (e !== "no-speech" && e !== "aborted") setError(String(e));
        setState("idle");
      },
    });
  };

  useEffect(() => {
    active.current = true;
    startListening();
    return () => {
      active.current = false;
      rec.current?.abort();
      stopSpeaking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!lastReply || lastReply.id === spokenId.current || busy) return;
    spokenId.current = lastReply.id;
    setState("speaking");
    speak(lastReply.text, bot?.voice ?? {}, () => {
      setState("idle");
      setTimeout(startListening, 250);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastReply?.id, busy]);

  const label =
    state === "listening" ? "Lyssnar…" : state === "thinking" ? `${bot?.name ?? "Boten"} arbetar…` : state === "speaking" ? `${bot?.name ?? "Boten"} pratar` : "Tryck för att prata";

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg/95 backdrop-blur">
      <button onClick={onClose} className="absolute right-4 top-4 rounded-xl p-2 text-muted hover:bg-raise" aria-label="Stäng röstläge">
        <X size={22} />
      </button>
      <div className={cx("rounded-full p-3 transition-all", state === "listening" && "ring-4 ring-ember/40", state === "speaking" && "ring-4 ring-sage/40")}>
        <BotAvatar bot={bot} size={112} />
      </div>
      <div className="mt-6 text-lg font-medium">{label}</div>
      <div className="mt-2 min-h-12 max-w-md px-6 text-center text-ink2">{partial}</div>
      {error && <div className="mt-2 text-sm text-danger">{error}</div>}
      <div className="mt-8 flex gap-3">
        {state === "speaking" ? (
          <Button
            onClick={() => {
              stopSpeaking();
              setState("idle");
              startListening();
            }}
          >
            Avbryt och prata
          </Button>
        ) : (
          <Button variant="primary" onClick={() => (state === "listening" ? rec.current?.stop() : startListening())} disabled={state === "thinking"}>
            <Mic size={16} /> {state === "listening" ? "Klar" : "Prata"}
          </Button>
        )}
      </div>
    </div>
  );
}
