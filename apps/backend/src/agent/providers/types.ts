import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../../config.js";
import type { Block } from "../../types.js";

/** A message as the model should see it (already rewritten for multi-bot threads). */
export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  content: Block[];
  raw?: { provider: string; model: string; content: unknown } | null;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema (object)
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
  onText?: (delta: string) => void;
  signal?: AbortSignal;
  /** Name of the bot – used by the demo provider. */
  botName?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  /** Provider-native assistant content, replayed verbatim to the same model (keeps thinking blocks valid). */
  raw: unknown;
  stopReason: string;
  usage: { input: number; output: number };
}

export interface ModelInfo {
  provider: string;
  id: string;
  label: string;
}

export interface Provider {
  id: string;
  label: string;
  configured(): boolean;
  defaultModel(): string;
  listModels(): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResult>;
}

export async function loadImage(ref: string): Promise<{ data: string; mime: string } | null> {
  const abs = path.resolve(config.dataDir, ref);
  if (!abs.startsWith(path.resolve(config.dataDir) + path.sep)) return null;
  try {
    const buf = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return { data: buf.toString("base64"), mime };
  } catch {
    return null;
  }
}

export function fileMention(b: Extract<Block, { type: "file" }>) {
  return `[Bifogad fil: ${b.name} (${b.mime}, ${Math.round(b.size / 1024)} kB) – sparad på datorn som ${b.path}]`;
}
