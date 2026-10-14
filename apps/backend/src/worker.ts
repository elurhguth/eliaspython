import { Worker } from "bullmq";
import { config } from "./config.js";
import { migrate, sql } from "./db.js";
import { redisConnection } from "./events.js";
import { processRun } from "./agent/loop.js";
import { enqueueRun } from "./queue.js";
import { syncRoutineSchedule, triggerRoutine, type RoutineRow } from "./routines.js";

async function main() {
  await migrate();

  const runs = new Worker(
    "runs",
    async (job) => {
      await processRun(job.data.runId as string);
    },
    { connection: redisConnection(), concurrency: config.workerConcurrency, lockDuration: 120_000 },
  );
  runs.on("failed", (job, err) => console.error(`[worker] run job ${job?.id} failed`, err?.message));

  const routines = new Worker(
    "routines",
    async (job) => {
      await triggerRoutine(job.data.routineId as string);
    },
    { connection: redisConnection(), concurrency: 2 },
  );
  routines.on("failed", (job, err) => console.error(`[worker] routine job ${job?.id} failed`, err?.message));

  // Make sure every routine in the DB has its schedule registered.
  const all = await sql<RoutineRow[]>`select * from routines`;
  for (const r of all) await syncRoutineSchedule(r).catch((e) => console.error(`[worker] routine ${r.name}:`, e.message));

  // Resume runs that were in flight when the worker stopped.
  const inflight = await sql<{ id: string }[]>`select id from runs where status in ('queued', 'running')`;
  for (const r of inflight) await enqueueRun(r.id);
  console.log(`[worker] ready (concurrency ${config.workerConcurrency}); resumed ${inflight.length} run(s), ${all.length} routine(s)`);

  const shutdown = async () => {
    await Promise.allSettled([runs.close(), routines.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
