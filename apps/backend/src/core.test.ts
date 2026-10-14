import { describe, expect, it } from "vitest";
import { redact, redactString } from "./redact.js";
import { classifyShell, classifyText } from "./agent/policy.js";
import { buildHistory } from "./agent/history.js";
import { resolveLogical, slugifyName } from "./memory.js";
import { mentionedBots } from "./crew.js";
import type { BotRow, MessageRow } from "./types.js";

const bot = (id: string, name: string, slug = name.toLowerCase()): BotRow =>
  ({ id, name, slug, role: "", avatar: "", color: "", instructions: "", provider: "demo", model: "demo", voice: {}, is_lead: false, sort: 0, created_at: "", updated_at: "" }) as BotRow;

let seq = 0;
const msg = (p: Partial<MessageRow>): MessageRow =>
  ({ id: `m${++seq}`, thread_id: "t", seq: String(seq), author_type: "user", bot_id: null, run_id: null, role: "user", content: [], raw: null, created_at: "", ...p }) as MessageRow;

describe("redaction", () => {
  it("masks API keys and secret-looking fields", () => {
    expect(redactString("key sk-ant-abcdefghijklmnop123 ok")).not.toContain("abcdefghijklmnop");
    expect(redactString("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const r = redact({ password: "hunter2", input_tokens: "1234", nested: { api_key: "x123456" }, text: "hej" }) as any;
    expect(r.password).toBe("••••");
    expect(r.nested.api_key).toBe("••••");
    expect(r.input_tokens).toBe("1234");
    expect(r.text).toBe("hej");
  });
});

describe("risk classification", () => {
  it("flags sending, buying, deleting and logging in (sv + en)", () => {
    expect(classifyText("Klicka Skicka för att skicka mejlet till Anna")?.actionType).toBe("send");
    expect(classifyText("Click Buy now to purchase")?.actionType).toBe("purchase");
    expect(classifyText("Radera kontot")?.actionType).toBe("delete");
    expect(classifyText("Logga in på Gmail")?.actionType).toBe("login");
    expect(classifyText("Öppna nästa sida i resultatlistan")).toBeNull();
  });
  it("flags risky shell commands only", () => {
    expect(classifyShell("rm -rf ~/projekt")?.actionType).toBe("shell");
    expect(classifyShell("curl -X POST https://api.example.com")?.actionType).toBe("shell");
    expect(classifyShell("git push origin main")?.actionType).toBe("shell");
    expect(classifyShell("ls -la && cat notes.txt")).toBeNull();
    expect(classifyShell("python3 analys.py")).toBeNull();
  });
});

describe("memory paths", () => {
  it("accepts the three scopes and rejects traversal", () => {
    expect(resolveLogical("shared/om-mig.md").scope).toBe("shared");
    expect(resolveLogical("skills/veckorapport.md").scope).toBe("skill");
    expect(resolveLogical("bots/123e4567-e89b-12d3-a456-426614174000/x.md").scope).toBe("bot");
    expect(() => resolveLogical("shared/../../etc/passwd")).toThrow();
    expect(() => resolveLogical("bots/not-a-uuid/x.md")).toThrow();
    expect(() => resolveLogical("shared/.hidden.md")).toThrow();
  });
  it("slugifies names", () => {
    expect(slugifyName("Om Användaren")).toBe("om-anvandaren.md");
    expect(slugifyName("../../x")).toBe("x.md");
    expect(slugifyName("")).toBe("notes.md");
  });
});

describe("mentions", () => {
  const team = [bot("1", "Vera"), bot("2", "Nils"), bot("3", "Siri")];
  it("finds @slug mentions, case-insensitive, not inside emails", () => {
    expect(mentionedBots("@nils kan du kolla?", team).map((b) => b.id)).toEqual(["2"]);
    expect(mentionedBots("Hej @Vera och @siri!", team).map((b) => b.id).sort()).toEqual(["1", "3"]);
    expect(mentionedBots("mejla anna@nils.se", team)).toEqual([]);
  });
});

describe("history building", () => {
  const vera = bot("v", "Vera");
  const nils = bot("n", "Nils");
  const byId = new Map([vera, nils].map((b) => [b.id, b]));

  it("keeps own tool calls paired and defers interleaved messages", () => {
    const messages = [
      msg({ author_type: "user", role: "user", content: [{ type: "text", text: "Gör research" }] }),
      msg({ author_type: "bot", bot_id: "v", role: "assistant", content: [{ type: "tool_call", id: "c1", name: "web_search", input: {} }] }),
      // Nils posts while Vera's tool call is in flight
      msg({ author_type: "bot", bot_id: "n", role: "assistant", content: [{ type: "text", text: "Jag hjälper till" }] }),
      msg({ author_type: "bot", bot_id: "v", role: "tool", content: [{ type: "tool_result", toolCallId: "c1", name: "web_search", content: "res" }] }),
    ];
    const h = buildHistory(messages, vera, byId, true);
    expect(h.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect((h[3].content[0] as any).text).toBe("[Nils]: Jag hjälper till");
    expect((h[0].content[0] as any).text).toBe("[Användaren]: Gör research");
  });

  it("hides other bots' tool traffic and own notes", () => {
    const messages = [
      msg({ author_type: "user", role: "user", content: [{ type: "text", text: "Hej" }] }),
      msg({ author_type: "bot", bot_id: "n", role: "assistant", content: [{ type: "tool_call", id: "x", name: "shell_run", input: {} }] }),
      msg({ author_type: "bot", bot_id: "n", role: "tool", content: [{ type: "tool_result", toolCallId: "x", name: "shell_run", content: "ok" }] }),
      msg({ author_type: "bot", bot_id: "v", role: "note", content: [{ type: "text", text: "@nils gör X" }] }),
    ];
    const h = buildHistory(messages, vera, byId, false);
    expect(h).toHaveLength(1);
    expect(h[0].role).toBe("user");
  });

  it("adds synthetic results for orphaned tool calls", () => {
    const messages = [
      msg({ author_type: "user", role: "user", content: [{ type: "text", text: "1" }] }),
      msg({ author_type: "bot", bot_id: "v", role: "assistant", content: [{ type: "tool_call", id: "a", name: "x", input: {} }] }),
      msg({ author_type: "user", role: "user", content: [{ type: "text", text: "2" }] }),
      msg({ author_type: "bot", bot_id: "v", role: "assistant", content: [{ type: "text", text: "svar" }] }),
    ];
    const h = buildHistory(messages, vera, byId, false);
    const toolIdx = h.findIndex((m) => m.role === "tool");
    expect(toolIdx).toBe(2);
    expect((h[toolIdx].content[0] as any).toolCallId).toBe("a");
  });

  it("keeps only the newest screenshots", () => {
    const messages: MessageRow[] = [msg({ author_type: "user", role: "user", content: [{ type: "text", text: "go" }] })];
    for (let i = 0; i < 5; i++) {
      messages.push(msg({ author_type: "bot", bot_id: "v", role: "assistant", content: [{ type: "tool_call", id: `s${i}`, name: "browser_screenshot", input: {} }] }));
      messages.push(msg({ author_type: "bot", bot_id: "v", role: "tool", content: [{ type: "tool_result", toolCallId: `s${i}`, name: "browser_screenshot", content: "ok", image: `screenshots/${i}.jpg` }] }));
    }
    const h = buildHistory(messages, vera, byId, false);
    const images = h.flatMap((m) => m.content).filter((b: any) => b.type === "tool_result" && b.image);
    expect(images).toHaveLength(3);
  });
});
