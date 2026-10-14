import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionContentPart } from "openai/resources/chat/completions";
import { config } from "../../config.js";
import type { ChatRequest, ChatResult, LlmMessage, ModelInfo, Provider, ToolCall } from "./types.js";
import { fileMention, loadImage } from "./types.js";

/**
 * OpenAI-compatible chat completions. Used for xAI (https://api.x.ai/v1) and for
 * any other compatible endpoint (Ollama, OpenRouter, LM Studio, vLLM …).
 */

async function toOpenAI(system: string, messages: LlmMessage[]): Promise<ChatCompletionMessageParam[]> {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => (b as any).text).join("");
      const calls = m.content.filter((b) => b.type === "tool_call") as Extract<LlmMessage["content"][number], { type: "tool_call" }>[];
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }
    const parts: ChatCompletionContentPart[] = [];
    const images: ChatCompletionContentPart[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.toolCallId, content: b.content || "(empty)" });
        if (b.image) {
          const img = await loadImage(b.image);
          if (img) images.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } });
        }
      } else if (b.type === "text" && b.text.trim()) parts.push({ type: "text", text: b.text });
      else if (b.type === "file") parts.push({ type: "text", text: fileMention(b) });
      else if (b.type === "image") {
        const img = await loadImage(b.ref);
        if (img) parts.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } });
      }
    }
    // Tool messages cannot carry images – send screenshots as a follow-up user message.
    if (images.length) parts.unshift({ type: "text", text: "Skärmdump(ar) från verktyget ovan:" }, ...images);
    if (parts.length) {
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) (prev.content as ChatCompletionContentPart[]).push(...parts);
      else out.push({ role: "user", content: parts });
    }
  }
  return out;
}

function makeProvider(opts: {
  id: string;
  label: () => string;
  apiKey: () => string;
  baseUrl: () => string;
  defaultModel: () => string;
}): Provider {
  let client: OpenAI | null = null;
  const getClient = () => {
    if (!client) client = new OpenAI({ apiKey: opts.apiKey() || "none", baseURL: opts.baseUrl(), maxRetries: 3, timeout: 600_000 });
    return client;
  };
  return {
    id: opts.id,
    get label() {
      return opts.label();
    },
    configured: () => !!opts.baseUrl() && (!!opts.apiKey() || opts.id === "openai"),
    defaultModel: opts.defaultModel,
    async listModels(): Promise<ModelInfo[]> {
      const res = await getClient().models.list();
      const out: ModelInfo[] = [];
      for await (const m of res) out.push({ provider: opts.id, id: m.id, label: m.id });
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },
    async chat(req: ChatRequest): Promise<ChatResult> {
      const messages = await toOpenAI(req.system, req.messages);
      const stream = await getClient().chat.completions.create(
        {
          model: req.model,
          messages,
          tools: req.tools.length
            ? req.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }))
            : undefined,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: req.signal },
      );
      let text = "";
      let finish = "stop";
      const usage = { input: 0, output: 0 };
      const calls = new Map<number, { id: string; name: string; args: string }>();
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage.input = chunk.usage.prompt_tokens ?? 0;
          usage.output = chunk.usage.completion_tokens ?? 0;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const d = choice.delta;
        if (d?.content) {
          text += d.content;
          req.onText?.(d.content);
        }
        for (const tc of d?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      const toolCalls: ToolCall[] = [];
      if (finish !== "length") {
        for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
          let input: Record<string, unknown> = {};
          try {
            input = c.args ? JSON.parse(c.args) : {};
          } catch {
            input = { __invalid_json: c.args };
          }
          toolCalls.push({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, input });
        }
      }
      return { text, toolCalls, raw: null, stopReason: finish, usage };
    },
  };
}

export const xaiProvider = makeProvider({
  id: "xai",
  label: () => "xAI",
  apiKey: () => config.xai.apiKey,
  baseUrl: () => config.xai.baseUrl,
  defaultModel: () => config.xai.defaultModel,
});

export const openaiCompatProvider = makeProvider({
  id: "openai",
  label: () => config.openaiCompat.label,
  apiKey: () => config.openaiCompat.apiKey,
  baseUrl: () => config.openaiCompat.baseUrl,
  defaultModel: () => config.openaiCompat.defaultModel,
});
