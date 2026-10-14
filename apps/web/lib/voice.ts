/* Browser-native voice: Web Speech API for dictation (STT) and speechSynthesis for TTS.
   No API keys and no audio leaves the browser except what the browser vendor's STT uses. */

export interface BotVoice {
  voiceURI?: string;
  rate?: number;
  pitch?: number;
  autoSpeak?: boolean;
}

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
};

export function sttSupported() {
  return typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

export function ttsSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function listen(opts: {
  lang?: string;
  continuous?: boolean;
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onEnd?: () => void;
  onError?: (err: string) => void;
}) {
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) {
    opts.onError?.("Röstinmatning stöds inte i den här webbläsaren (prova Chrome, Edge eller Safari).");
    return null;
  }
  const rec: Recognition = new Ctor();
  rec.lang = opts.lang ?? (navigator.language || "sv-SE");
  rec.continuous = !!opts.continuous;
  rec.interimResults = true;
  let finalText = "";
  rec.onresult = (e: any) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    opts.onPartial?.((finalText + " " + interim).trim());
  };
  rec.onerror = (e: any) => opts.onError?.(e?.error ?? "fel");
  rec.onend = () => {
    if (finalText.trim()) opts.onFinal(finalText.trim());
    opts.onEnd?.();
  };
  rec.start();
  return rec;
}

export function voices(): SpeechSynthesisVoice[] {
  if (!ttsSupported()) return [];
  return window.speechSynthesis.getVoices();
}

/** Strip markdown so it reads naturally. */
function speakable(md: string) {
  return md
    .replace(/```[\s\S]*?```/g, " (kodblock) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#*_>|~-]{1,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function speak(text: string, v: BotVoice = {}, onEnd?: () => void) {
  if (!ttsSupported()) {
    onEnd?.();
    return;
  }
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(speakable(text).slice(0, 4000));
  const voice = voices().find((x) => x.voiceURI === v.voiceURI) ?? voices().find((x) => x.lang?.startsWith("sv"));
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else u.lang = "sv-SE";
  u.rate = v.rate ?? 1.05;
  u.pitch = v.pitch ?? 1;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  synth.speak(u);
}

export function stopSpeaking() {
  if (ttsSupported()) window.speechSynthesis.cancel();
}
