import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Provider adapters against local fake servers that speak the Anthropic
 * Messages SSE protocol and the OpenAI chat-completions SSE protocol.
 */

let server: http.Server;
let base = "";
const seen: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];

function sse(res: http.ServerResponse, events: [string | null, unknown][]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [event, data] of events) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  }
  res.end();
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      if (req.url?.startsWith("/anthropic/v1/messages")) {
        const usage = { input_tokens: 42, output_tokens: 7 };
        return sse(res, [
          ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Jag " } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "kollar." } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "web_search", input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } }],
          ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"elcyklar"}' } }],
          ["content_block_stop", { type: "content_block_stop", index: 1 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } }],
          ["message_stop", { type: "message_stop" }],
        ]);
      }
      if (req.url?.startsWith("/openai/chat/completions")) {
        const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => [
          null,
          { id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) },
        ];
        return sse(res, [
          chunk({ role: "assistant", content: "Okej, " }) as [null, unknown],
          chunk({ content: "jag kör." }) as [null, unknown],
          chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "shell_run", arguments: '{"comm' } }] }) as [null, unknown],
          chunk({ tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }) as [null, unknown],
          chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "file_read", arguments: '{"path":"a.txt"}' } }] }) as [null, unknown],
          chunk({}, "tool_calls") as [null, unknown],
          chunk(null, null, { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }) as [null, unknown],
          [null, "[DONE]"],
        ]);
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-123456";
  process.env.ANTHROPIC_BASE_URL_OVERRIDE = `${base}/anthropic`;
  process.env.XAI_API_KEY = "xai-test-key-123456";
  process.env.XAI_BASE_URL = `${base}/openai`;
  process.env.DATA_DIR = "/tmp";
});

afterAll(() => server?.close());

const history = [
  { role: "user" as const, content: [{ type: "text" as const, text: "Sök elcyklar" }] },
  { role: "assistant" as const, content: [{ type: "tool_call" as const, id: "call:other/provider", name: "web_fetch", input: { url: "https://x.se" } }] },
  { role: "tool" as const, content: [{ type: "tool_result" as const, toolCallId: "call:other/provider", name: "web_fetch", content: "sidtext" }] },
  { role: "user" as const, content: [{ type: "text" as const, text: "[Nils]: Fortsätt" }] },
];
const tools = [{ name: "web_search", description: "Sök", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];

describe("anthropic provider", () => {
  it("streams text, parses tool calls and sends a valid request", async () => {
    const { anthropicProvider } = await import("./agent/providers/anthropic.js");
    let streamed = "";
    const res = await anthropicProvider.chat({ model: "claude-opus-5-5", system: "Du är Vera", messages: history, tools, onText: (d) => (streamed += d) });
    expect(streamed).toBe("Jag kollar.");
    expect(res.text).toBe("Jag kollar.");
    expect(res.toolCalls).toEqual([{ id: "toolu_1", name: "web_search", input: { query: "elcyklar" } }]);
    expect(res.usage).toEqual({ input: 42, output: 7 });
    expect(Array.isArray(res.raw)).toBe(true);

    const req = seen.find((s) => s.path.startsWith("/anthropic/"))!;
    // Opus 5.5 → beta endpoint with server-side refusal fallback
    expect(String(req.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(req.body.fallbacks).toBe("default");
    expect(req.body.system[0]).toMatchObject({ type: "text", text: "Du är Vera", cache_control: { type: "ephemeral" } });
    expect(req.body.tools[0]).toMatchObject({ name: "web_search", input_schema: { type: "object" } });
    expect(req.body.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    // foreign tool ids are sanitized consistently, results come first in the merged user turn
    expect(req.body.messages[1].content[0]).toMatchObject({ type: "tool_use", id: "call_other_provider" });
    expect(req.body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_other_provider" });
    expect(req.body.messages[2].content[1]).toMatchObject({ type: "text", text: "[Nils]: Fortsätt" });
    expect(req.body.stream).toBe(true);
  });

  it("replays raw content verbatim for the same model", async () => {
    const { anthropicProvider } = await import("./agent/providers/anthropic.js");
    seen.length = 0;
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Hej" }];
    await anthropicProvider.chat({
      model: "claude-haiku-5-5",
      system: "s",
      messages: [
        { role: "user", content: [{ type: "text", text: "hej" }] },
        { role: "assistant", content: [{ type: "text", text: "Hej" }], raw: { provider: "anthropic", model: "claude-haiku-5-5", content: raw } },
        { role: "user", content: [{ type: "text", text: "igen" }] },
      ],
      tools,
    });
    const req = seen.find((s) => s.path.startsWith("/anthropic/"))!;
    expect(req.body.messages[1].content).toEqual(raw);
    expect(req.headers["anthropic-beta"]).toBeUndefined(); // no fallback beta for Haiku
  });
});

describe("openai-compatible provider (xAI)", () => {
  it("streams text and assembles chunked tool calls", async () => {
    const { xaiProvider } = await import("./agent/providers/openai.js");
    seen.length = 0;
    let streamed = "";
    const res = await xaiProvider.chat({ model: "grok-4", system: "Du är Vera", messages: history, tools, onText: (d) => (streamed += d) });
    expect(streamed).toBe("Okej, jag kör.");
    expect(res.toolCalls).toEqual([
      { id: "call_a", name: "shell_run", input: { command: "ls" } },
      { id: "call_b", name: "file_read", input: { path: "a.txt" } },
    ]);
    expect(res.usage).toEqual({ input: 11, output: 5 });
    const req = seen.find((s) => s.path.startsWith("/openai/"))!;
    expect(req.headers.authorization).toBe("Bearer xai-test-key-123456");
    expect(req.body.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(req.body.messages[2].tool_calls[0]).toMatchObject({ id: "call:other/provider", type: "function", function: { name: "web_fetch" } });
    expect(req.body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "call:other/provider", content: "sidtext" });
    expect(req.body.tools[0]).toMatchObject({ type: "function", function: { name: "web_search" } });
  });
});
