import { Redis } from "ioredis";
import { config } from "./config.js";
import { redact } from "./redact.js";

/**
 * Live events (run progress, streaming text, approvals …) go over Redis
 * pub/sub so the worker can publish and every API instance can fan out to
 * connected browsers via SSE. Events are ephemeral – everything that matters
 * is also persisted in Postgres.
 */

export const CHANNEL = "crew:events";

export type CrewEvent =
  | { type: "delta"; threadId: string; runId: string; botId: string; text: string }
  | { type: "message"; threadId: string; message: unknown }
  | { type: "run"; threadId: string; run: unknown }
  | { type: "step"; threadId: string; runId: string; step: unknown }
  | { type: "approval"; threadId: string; approval: unknown }
  | { type: "thread"; thread: unknown }
  | { type: "memory"; path: string; action: string; botId?: string | null; threadId?: string | null }
  | { type: "routine"; routineId: string }
  | { type: "bots" };

let pub: Redis | null = null;

export function redisConnection() {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
}

export async function publish(event: CrewEvent) {
  if (!pub) pub = redisConnection();
  await pub.publish(CHANNEL, JSON.stringify(redact(event)));
}

export function subscribe(handler: (e: CrewEvent) => void) {
  const sub = redisConnection();
  sub.subscribe(CHANNEL).catch((err) => console.error("[events] subscribe failed", err));
  sub.on("message", (_ch, msg) => {
    try {
      handler(JSON.parse(msg));
    } catch {
      /* ignore */
    }
  });
  return () => sub.disconnect();
}
