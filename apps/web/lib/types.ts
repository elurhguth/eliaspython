export type Block =
  | { type: "text"; text: string }
  | { type: "image"; ref: string; mime: string; name?: string }
  | { type: "file"; attachmentId: string; name: string; path: string; mime: string; size: number }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; name: string; content: string; isError?: boolean; image?: string };

export interface Bot {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatar: string;
  color: string;
  instructions: string;
  provider: string;
  model: string;
  voice: { voiceURI?: string; rate?: number; pitch?: number; autoSpeak?: boolean };
  is_lead: boolean;
  sort: number;
}

export interface Thread {
  id: string;
  title: string;
  kind: "direct" | "group" | "routine";
  model_override: Record<string, { provider: string; model: string }> | null;
  routine_id: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  bot_ids: string[];
  last_run_status: RunStatus | null;
  deleted?: boolean;
}

export interface Message {
  id: string;
  thread_id: string;
  seq: string;
  author_type: "user" | "bot" | "system";
  bot_id: string | null;
  run_id: string | null;
  role: "user" | "assistant" | "tool" | "note";
  content: Block[];
  created_at: string;
}

export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting_handoff" | "done" | "error" | "cancelled";

export interface Run {
  id: string;
  thread_id: string;
  bot_id: string;
  status: RunStatus;
  trigger: string;
  routine_id: string | null;
  depth: number;
  provider: string | null;
  model: string | null;
  error: string | null;
  summary: string | null;
  step_count: number;
  input_tokens: string;
  output_tokens: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Step {
  id: string;
  run_id: string;
  tool_call_id: string | null;
  kind: string;
  title: string;
  detail: { tool?: string; input?: Record<string, unknown> };
  result: Extract<Block, { type: "tool_result" }> | null;
  screenshot: string | null;
  status: "running" | "waiting" | "done" | "error" | "cancelled";
  created_at: string;
  finished_at: string | null;
}

export interface Approval {
  id: string;
  run_id: string;
  bot_id: string;
  thread_id: string;
  tool_call_id: string;
  kind: "approval" | "handoff";
  action_type: string;
  summary: string;
  detail: { tool?: string; input?: Record<string, unknown>; reason?: string };
  status: "pending" | "allowed" | "denied" | "done";
  scope: "once" | "always" | null;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface ModelInfo {
  provider: string;
  id: string;
  label: string;
}

export interface ModelsResponse {
  providers: { id: string; label: string; configured: boolean; error?: string }[];
  models: ModelInfo[];
}

export interface Bootstrap {
  user: { id: string; username: string };
  bots: Bot[];
  threads: Thread[];
  approvals: Approval[];
  models: ModelsResponse;
  workstation: { ok: boolean; browser: boolean };
  actionTypes: Record<string, string>;
  defaultModel: { provider: string; model: string };
}

export type CrewEvent =
  | { type: "delta"; threadId: string; runId: string; botId: string; text: string }
  | { type: "message"; threadId: string; message: Message }
  | { type: "run"; threadId: string; run: Run }
  | { type: "step"; threadId: string; runId: string; step: Step }
  | { type: "approval"; threadId: string; approval: Approval }
  | { type: "thread"; thread: Thread }
  | { type: "memory"; path: string; action: string; botId?: string | null; threadId?: string | null }
  | { type: "routine"; routineId: string }
  | { type: "bots" };

export const ACTIVE: RunStatus[] = ["queued", "running", "waiting_approval", "waiting_handoff"];
