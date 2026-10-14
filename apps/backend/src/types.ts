/** Provider-neutral message content stored in the database. */
export type Block =
  | { type: "text"; text: string }
  | { type: "image"; ref: string; mime: string; name?: string } // ref = data-dir relative path (screenshots/…, uploads/…)
  | { type: "file"; attachmentId: string; name: string; path: string; mime: string; size: number }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; name: string; content: string; isError?: boolean; image?: string };

export type Role = "user" | "assistant" | "tool" | "note";

export interface MessageRow {
  id: string;
  thread_id: string;
  seq: string;
  author_type: "user" | "bot" | "system";
  bot_id: string | null;
  run_id: string | null;
  role: Role;
  content: Block[];
  raw: { provider: string; model: string; content: unknown } | null;
  created_at: string;
}

export interface BotRow {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatar: string;
  color: string;
  instructions: string;
  provider: string;
  model: string;
  voice: Record<string, unknown>;
  is_lead: boolean;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface ThreadRow {
  id: string;
  title: string;
  kind: "direct" | "group" | "routine";
  model_override: { provider: string; model: string } | null;
  routine_id: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting_handoff" | "done" | "error" | "cancelled";

export interface RunRow {
  id: string;
  thread_id: string;
  bot_id: string;
  status: RunStatus;
  trigger: "chat" | "routine" | "delegation" | "webhook" | "resume";
  routine_id: string | null;
  parent_run_id: string | null;
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

export interface ApprovalRow {
  id: string;
  run_id: string;
  bot_id: string;
  thread_id: string;
  tool_call_id: string;
  kind: "approval" | "handoff";
  action_type: string;
  summary: string;
  detail: Record<string, unknown>;
  status: "pending" | "allowed" | "denied" | "done";
  scope: "once" | "always" | null;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

export const ACTIVE_STATUSES: RunStatus[] = ["queued", "running", "waiting_approval", "waiting_handoff"];
