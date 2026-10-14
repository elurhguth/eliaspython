import type { ChatRequest, ChatResult, LlmMessage, Provider, ToolCall } from "./types.js";

/**
 * Offline demo "model". No AI – it follows simple Swedish/English keywords so
 * the whole system (computer, tools, approvals, handoff, memory …) can be tried
 * and tested without any API key.
 *
 *   "öppna example.com"            -> browser
 *   "kör ls -la"                    -> terminal
 *   "skriv filen notes.txt: hej"    -> file
 *   "kom ihåg att jag gillar te"    -> shared memory
 *   "sök efter X"                   -> web search
 *   "skicka …"                      -> a risky click (asks for approval)
 *   "logga in …"                    -> secure handoff
 *   "lämna över till nils: kör ls"  -> delegate to a teammate
 */

function lastUserText(messages: LlmMessage[]): { text: string; index: number } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      const t = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b as any).text as string)
        .join(" ");
      if (t.trim()) return { text: t, index: i };
    }
  }
  return { text: "", index: -1 };
}

function plan(text: string): Omit<ToolCall, "id">[] {
  const t = text.replace(/^\[[^\]]+\]:\s*/, "").replace(/^@[\w-]+\s+/, "").trim();
  const lower = t.toLowerCase();
  const calls: Omit<ToolCall, "id">[] = [];
  const url = t.match(/https?:\/\/[^\s)]+|\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|se|org|net|io|dev|ai|nu)\b[^\s)]*/i)?.[0];
  if (/logga in|log in|sign in|bankid/.test(lower)) {
    if (url) calls.push({ name: "browser_navigate", input: { url } });
    calls.push({ name: "request_takeover", input: { reason: "Inloggning krävs – logga in själv och lämna sedan tillbaka datorn." } });
    return calls;
  }
  const handover = t.match(/(?:lämna över till|delegera till|hand over to)\s+@?([\w-]+)\s*:?\s*([\s\S]+)/i);
  if (handover) {
    calls.push({ name: "delegate", input: { bot: handover[1].toLowerCase(), message: handover[2].trim() } });
    return calls;
  }
  if (/^(kör|run|\$)\s+/i.test(t)) {
    calls.push({ name: "shell_run", input: { command: t.replace(/^(kör|run|\$)\s+/i, "") } });
    return calls;
  }
  const fileMatch = t.match(/(?:skriv(?: filen)?|write(?: file)?)\s+([\w./-]+)\s*:\s*([\s\S]+)/i);
  if (fileMatch) {
    calls.push({ name: "file_write", input: { path: fileMatch[1], content: fileMatch[2] } });
    return calls;
  }
  const mem = t.match(/(?:kom ihåg(?: att)?|remember(?: that)?)\s+([\s\S]+)/i);
  if (mem) {
    calls.push({ name: "memory_write", input: { scope: "shared", file: "om-anvandaren", content: `- ${mem[1].trim()}`, mode: "append" } });
    return calls;
  }
  const search = t.match(/(?:sök(?: efter)?|search(?: for)?)\s+([\s\S]+)/i);
  if (search) {
    calls.push({ name: "web_search", input: { query: search[1].trim() } });
    return calls;
  }
  if (/\bskicka\b|\bsend\b|\bköp\b|\bbuy\b/.test(lower)) {
    if (url) calls.push({ name: "browser_navigate", input: { url } });
    calls.push({ name: "browser_click", input: { ref: 1, intent: t } });
    return calls;
  }
  if (url) {
    calls.push({ name: "browser_navigate", input: { url } });
    if (/skärmdump|screenshot|bild/.test(lower)) calls.push({ name: "browser_screenshot", input: {} });
  }
  return calls;
}

async function streamText(text: string, onText?: (d: string) => void, signal?: AbortSignal) {
  const words = text.split(/(\s+)/);
  for (const w of words) {
    if (signal?.aborted) break;
    onText?.(w);
    await new Promise((r) => setTimeout(r, 12));
  }
}

export const demoProvider: Provider = {
  id: "demo",
  label: "Demo (offline)",
  configured: () => true,
  defaultModel: () => "demo",
  async listModels() {
    return [{ provider: "demo", id: "demo", label: "Demo – ingen AI (offline)" }];
  },
  async chat(req: ChatRequest): Promise<ChatResult> {
    const { text, index } = lastUserText(req.messages);
    const after = req.messages.slice(index + 1);
    const results = after.flatMap((m) => m.content.filter((b) => b.type === "tool_result")) as any[];
    const steps = plan(text);
    if (results.length < steps.length && !results.some((r) => r.isError && /nekade|denied/i.test(r.content))) {
      const next = steps[results.length];
      const call: ToolCall = { id: `demo_${Date.now()}_${results.length}`, ...next };
      const say = results.length === 0 ? "Jag sätter igång. " : "";
      await streamText(say, req.onText, req.signal);
      return { text: say, toolCalls: [call], raw: null, stopReason: "tool_use", usage: { input: 0, output: 0 } };
    }
    let reply: string;
    if (!steps.length) {
      reply =
        `Hej! Jag är **${req.botName ?? "din bot"}** och kör i *demoläge* (ingen AI-modell är kopplad ännu).\n\n` +
        "Lägg in `ANTHROPIC_API_KEY` eller `XAI_API_KEY` i `.env` och välj modell för boten. Tills dess kan du testa datorn:\n\n" +
        "- `öppna example.com och ta en skärmdump`\n- `kör uname -a`\n- `skriv filen hej.txt: Hej från Crew`\n- `kom ihåg att jag dricker te`\n- `skicka mejlet på example.com` (kräver godkännande)\n- `logga in på example.com` (secure handoff)";
    } else {
      const lines = results.map((r) => {
        const first = String(r.content).split("\n").slice(0, 6).join("\n");
        return `**${r.name}** ${r.isError ? "misslyckades" : "klart"}:\n\`\`\`\n${first.slice(0, 600)}\n\`\`\``;
      });
      reply = `Klart! Här är vad som hände:\n\n${lines.join("\n\n")}`;
    }
    await streamText(reply, req.onText, req.signal);
    return { text: reply, toolCalls: [], raw: null, stopReason: "end_turn", usage: { input: 0, output: 0 } };
  },
};
