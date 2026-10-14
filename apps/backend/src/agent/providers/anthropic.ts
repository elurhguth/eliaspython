import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import { config } from "../../config.js";
import type { ChatRequest, ChatResult, LlmMessage, ModelInfo, Provider } from "./types.js";
import { fileMention, loadImage } from "./types.js";

let client: Anthropic | null = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.anthropic.apiKey, baseURL: config.anthropic.baseUrl, maxRetries: 3 });
  return client;
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = /^claude-(opus-5|fable-5|sonnet-5-5)/;

/** Anthropic tool ids must match ^[a-zA-Z0-9_-]+$ – ids from other providers may not. */
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

async function toAnthropic(messages: LlmMessage[], model: string): Promise<Anthropic.MessageParam[]> {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    let role: "user" | "assistant";
    let blocks: Anthropic.ContentBlockParam[] = [];
    if (m.role === "assistant") {
      role = "assistant";
      if (m.raw && m.raw.provider === "anthropic" && m.raw.model === model && Array.isArray(m.raw.content)) {
        // Same model: replay the exact content (thinking blocks must be passed back unchanged).
        blocks = m.raw.content as Anthropic.ContentBlockParam[];
      } else {
        for (const b of m.content) {
          if (b.type === "text" && b.text.trim()) blocks.push({ type: "text", text: b.text });
          if (b.type === "tool_call") blocks.push({ type: "tool_use", id: safeId(b.id), name: b.name, input: b.input });
        }
      }
    } else {
      role = "user";
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim()) blocks.push({ type: "text", text: b.text });
        else if (b.type === "file") blocks.push({ type: "text", text: fileMention(b) });
        else if (b.type === "image") {
          const img = await loadImage(b.ref);
          if (img) blocks.push({ type: "image", source: { type: "base64", media_type: img.mime as any, data: img.data } });
        } else if (b.type === "tool_result") {
          const content: Anthropic.ToolResultBlockParam["content"] = [{ type: "text", text: b.content || "(empty)" }];
          if (b.image) {
            const img = await loadImage(b.image);
            if (img) content.push({ type: "image", source: { type: "base64", media_type: img.mime as any, data: img.data } });
          }
          blocks.push({ type: "tool_result", tool_use_id: safeId(b.toolCallId), content, ...(b.isError ? { is_error: true } : {}) });
        }
      }
    }
    if (!blocks.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) {
      // Merge consecutive same-role turns. Tool results must stay first in a user turn.
      const prevBlocks = prev.content as Anthropic.ContentBlockParam[];
      const results = [...prevBlocks, ...blocks].filter((b) => b.type === "tool_result");
      const rest = [...prevBlocks, ...blocks].filter((b) => b.type !== "tool_result");
      prev.content = role === "user" ? [...results, ...rest] : [...prevBlocks, ...blocks];
    } else {
      out.push({ role, content: blocks });
    }
  }
  // The conversation must start with a user turn.
  if (out[0]?.role === "assistant") out.unshift({ role: "user", content: [{ type: "text", text: "(fortsättning)" }] });
  return out;
}

export const anthropicProvider: Provider = {
  id: "anthropic",
  label: "Anthropic",
  configured: () => !!config.anthropic.apiKey,
  defaultModel: () => config.anthropic.defaultModel,
  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    for await (const m of getClient().models.list()) {
      models.push({ provider: "anthropic", id: m.id, label: m.display_name ?? m.id });
    }
    return models;
  },
  async chat(req: ChatRequest): Promise<ChatResult> {
    const messages = await toAnthropic(req.messages, req.model);
    // Cache breakpoint on the newest message so long agent runs re-use the prefix.
    const last = messages[messages.length - 1];
    if (last && Array.isArray(last.content) && last.content.length) {
      const lb = last.content[last.content.length - 1] as any;
      if (lb.type !== "thinking" && lb.type !== "redacted_thinking") lb.cache_control = { type: "ephemeral" };
    }
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: 32_000,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      })),
      messages,
      stream: true,
    };
    const useFallback = config.anthropic.refusalFallback && FALLBACK_MODELS.test(req.model);
    const stream: MessageStream = useFallback
      ? (getClient().beta.messages.stream(
          { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as any,
          { signal: req.signal },
        ) as unknown as MessageStream)
      : getClient().messages.stream(params, { signal: req.signal });
    stream.on("text", (delta) => req.onText?.(delta));
    const msg = await stream.finalMessage();

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls =
      msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens"
        ? []
        : msg.content
            .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
            .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
    let finalText = text;
    if (msg.stop_reason === "refusal") finalText = (text ? text + "\n\n" : "") + "_(Modellen avböjde att fortsätta med den här begäran.)_";
    // Keep the raw content only when it can be replayed (drops truncated tool calls).
    const raw = msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens" ? null : msg.content;
    return {
      text: finalText,
      toolCalls,
      raw,
      stopReason: msg.stop_reason ?? "end_turn",
      usage: { input: msg.usage.input_tokens ?? 0, output: msg.usage.output_tokens ?? 0 },
    };
  },
};
