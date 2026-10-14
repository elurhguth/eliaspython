import { Queue } from "bullmq";
import { redisConnection } from "./events.js";

/**
 * Background jobs live in Redis (BullMQ) and are processed by the worker
 * container, so runs keep going when no browser is connected.
 */

let runsQueue: Queue | null = null;
let routinesQueue: Queue | null = null;

export function getRunsQueue() {
  if (!runsQueue) runsQueue = new Queue("runs", { connection: redisConnection() });
  return runsQueue;
}

export function getRoutinesQueue() {
  if (!routinesQueue) routinesQueue = new Queue("routines", { connection: redisConnection() });
  return routinesQueue;
}

export async function enqueueRun(runId: string, delayMs = 0) {
  await getRunsQueue().add(
    "run",
    { runId },
    {
      jobId: `${runId}-${Date.now()}`,
      delay: delayMs,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    },
  );
}

let cancelRedis: ReturnType<typeof redisConnection> | null = null;
function cr() {
  if (!cancelRedis) cancelRedis = redisConnection();
  return cancelRedis;
}

export async function requestCancel(runId: string) {
  await cr().set(`crew:cancel:${runId}`, "1", "EX", 3600);
}

export async function isCancelled(runId: string) {
  return (await cr().get(`crew:cancel:${runId}`)) === "1";
}

/** Per-run lock so a run is never processed by two workers at once. */
export async function acquireRunLock(runId: string, token: string, ttlSec = 120) {
  return (await cr().set(`crew:lock:run:${runId}`, token, "EX", ttlSec, "NX")) === "OK";
}

export async function refreshRunLock(runId: string, token: string, ttlSec = 120) {
  const key = `crew:lock:run:${runId}`;
  if ((await cr().get(key)) === token) await cr().expire(key, ttlSec);
}

export async function releaseRunLock(runId: string, token: string) {
  const key = `crew:lock:run:${runId}`;
  if ((await cr().get(key)) === token) await cr().del(key);
}
