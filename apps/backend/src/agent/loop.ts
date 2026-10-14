import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { json, sql } from "../db.js";
import { publish } from "../events.js";
import { notify } from "../push.js";
import {
  acquireRunLock,
  enqueueRun,
  isCancelled,
  refreshRunLock,
  releaseRunLock,
} from "../queue.js";
import { redactString, redact } from "../redact.js";
import { createRoutine } from "../routines.js";
import {
  addBotToThread,
  audit,
  dispatchMentions,
  ensureRun,
  getBot,
  getBots,
  getRun,
  getThread,
  insertMessage,
  publishRun,
  publishThread,
  textOf,
  threadBots,
} from "../crew.js";
import type { ApprovalRow, Block, BotRow, MessageRow, RunRow, ThreadRow } from "../types.js";
import { ws } from "../workstation.js";
import { buildHistory, loadThreadMessages } from "./history.js";
import { needsResponse, responseReason } from "./turns.js";
import { getPolicy } from "./policy.js";
import { systemPrompt } from "./prompt.js";
import { getProvider } from "./providers/index.js";
import { saveScreenshotFile, toolSpecs, toolsForBot, type Tool, type ToolContext, type ToolOutput } from "./tools.js";

type ToolCallBlock = Extract<Block, { type: "tool_call" }>;
type ToolResultBlock = Extract<Block, { type: "tool_result" }>;

const TERMINAL = new Set(["done", "error", "cancelled"]);

export async function processRun(runId: string) {
  const token = randomUUID();
  if (!(await acquireRunLock(runId, token))) {
    // Someone else is on it. If it is waiting for a worker (e.g. an approval landed while the
    // previous job was still releasing the lock), try again shortly so it is never stranded.
    const run = await getRun(runId);
    if (run?.status === "queued") await enqueueRun(runId, 3000);
    return;
  }
  const heartbeat = setInterval(() => refreshRunLock(runId, token).catch(() => {}), 30_000);
  try {
    await runLoop(runId);
  } catch (err) {
    console.error(`[run ${runId}] crashed`, err);
    const run = await getRun(runId);
    if (run && !TERMINAL.has(run.status)) await finish(run, "error", redactString(String((err as Error)?.message ?? err)));
  } finally {
    clearInterval(heartbeat);
    await releaseRunLock(runId, token);
  }
}

async function setStatus(runId: string, status: RunRow["status"]) {
  await sql`update runs set status = ${status}, started_at = coalesce(started_at, now()) where id = ${runId}`;
  const run = await publishRun(runId);
  if (run) await publishThread(run.thread_id);
}

function resolveModel(bot: BotRow, thread: ThreadRow) {
  const o = (thread.model_override as Record<string, { provider: string; model: string }> | null)?.[bot.id];
  return o ?? { provider: bot.provider, model: bot.model };
}

async function runLoop(runId: string) {
  let run = await getRun(runId);
  if (!run || TERMINAL.has(run.status)) return;
  if (run.status === "waiting_approval" || run.status === "waiting_handoff") {
    const [pending] = await sql`select id from approvals where run_id = ${runId} and status = 'pending' limit 1`;
    if (pending) return;
  }
  const bot = await getBot(run.bot_id);
  const thread = await getThread(run.thread_id);
  if (!bot || !thread) return finish(run, "error", "Boten eller tråden finns inte längre.");
  await setStatus(runId, "running");

  const team = await getBots();
  const botsById = new Map(team.map((b) => [b.id, b]));
  const { provider: providerId, model } = resolveModel(bot, thread);
  await sql`update runs set provider = ${providerId}, model = ${model} where id = ${runId}`;

  let provider;
  try {
    provider = getProvider(providerId);
  } catch (err) {
    await insertMessage({
      threadId: thread.id,
      authorType: "bot",
      botId: bot.id,
      runId,
      role: "assistant",
      content: [{ type: "text", text: `⚠️ ${(err as Error).message}. Byt modell för ${bot.name} eller lägg till nyckeln i \`.env\`.` }],
    });
    return finish(run, "error", (err as Error).message);
  }

  const tools = await toolsForBot(bot);
  const specs = toolSpecs(tools);
  const ctx: ToolContext = {
    run,
    bot,
    thread,
    saveScreenshot: (buf) => saveScreenshotFile(runId, buf),
    delegate: (slug, message) => delegate(run!, bot, thread, slug, message),
    createRoutine: async (i) => {
      const r = await createRoutine({ botId: bot.id, name: i.name, prompt: i.prompt, cron: i.cron, timezone: i.timezone });
      return `Routine "${r.name}" skapad (${r.cron}, ${r.timezone}). Användaren ser den under Routines.`;
    },
  };

  let seenSeq: bigint | undefined;
  for (;;) {
    if (await isCancelled(runId)) return finish(run, "cancelled");
    const messages = await loadThreadMessages(thread.id);
    const mine = messages.filter((m) => m.run_id === runId && m.bot_id === bot.id);
    const lastMine = mine[mine.length - 1];
    const pendingCalls = lastMine?.role === "assistant" ? (lastMine.content.filter((b) => b.type === "tool_call") as ToolCallBlock[]) : [];

    if (pendingCalls.length) {
      const outcome = await executeToolCalls(run, bot, thread, pendingCalls, tools, ctx);
      if (outcome === "waiting") return;
      continue;
    }

    if (!needsResponse(messages, bot, team, seenSeq)) return finish(run, "done", undefined, seenSeq);
    run = (await getRun(runId))!;
    if (run.step_count >= config.maxStepsPerRun) {
      await insertMessage({
        threadId: thread.id,
        authorType: "bot",
        botId: bot.id,
        runId,
        role: "assistant",
        content: [{ type: "text", text: `⏸️ Jag stannade efter ${run.step_count} steg (gränsen är ${config.maxStepsPerRun}). Skriv "fortsätt" så kör jag vidare.` }],
      });
      return finish(run, "done");
    }

    const members = await threadBots(thread.id);
    const history = buildHistory(messages, bot, botsById, members.length > 1);
    seenSeq = messages.length ? BigInt(messages[messages.length - 1].seq) : undefined;
    const system = await systemPrompt(bot, team, thread, members);

    // Stream text deltas to the UI, batched.
    let buffer = "";
    const flush = () => {
      if (!buffer) return;
      const text = buffer;
      buffer = "";
      publish({ type: "delta", threadId: thread.id, runId, botId: bot.id, text }).catch(() => {});
    };
    const flusher = setInterval(flush, 60);
    const abort = new AbortController();
    const cancelPoll = setInterval(async () => {
      if (await isCancelled(runId).catch(() => false)) abort.abort();
    }, 1000);

    let result;
    try {
      result = await provider.chat({
        model,
        system,
        messages: history,
        tools: specs,
        signal: abort.signal,
        botName: bot.name,
        onText: (d) => {
          buffer += d;
        },
      });
    } catch (err) {
      clearInterval(flusher);
      clearInterval(cancelPoll);
      flush();
      if (abort.signal.aborted) return finish(run, "cancelled");
      const msg = redactString(String((err as Error)?.message ?? err));
      await insertMessage({
        threadId: thread.id,
        authorType: "bot",
        botId: bot.id,
        runId,
        role: "assistant",
        content: [{ type: "text", text: `⚠️ Fel från modellen (${providerId}/${model}): ${msg}` }],
      });
      return finish(run, "error", msg);
    }
    clearInterval(flusher);
    clearInterval(cancelPoll);
    flush();

    const content: Block[] = [];
    if (result.text) content.push({ type: "text", text: result.text });
    for (const c of result.toolCalls) content.push({ type: "tool_call", id: c.id, name: c.name, input: c.input });
    if (!content.length) content.push({ type: "text", text: "" });
    await insertMessage({
      threadId: thread.id,
      authorType: "bot",
      botId: bot.id,
      runId,
      role: "assistant",
      content,
      raw: result.raw ? { provider: providerId, model, content: result.raw } : null,
    });
    await sql`update runs set step_count = step_count + 1,
      input_tokens = input_tokens + ${result.usage.input}, output_tokens = output_tokens + ${result.usage.output}
      where id = ${runId}`;
    if (result.stopReason === "max_tokens" || result.stopReason === "length") {
      await insertMessage({
        threadId: thread.id,
        authorType: "system",
        role: "user",
        content: [{ type: "text", text: "Ditt förra svar klipptes av (för långt). Fortsätt, i mindre delar." }],
      });
    }
  }
}

async function getApproval(runId: string, callId: string) {
  const [a] = await sql<ApprovalRow[]>`select * from approvals where run_id = ${runId} and tool_call_id = ${callId}`;
  return a ?? null;
}

async function createApproval(run: RunRow, bot: BotRow, call: ToolCallBlock, kind: "approval" | "handoff", actionType: string, summary: string, detail: unknown) {
  const [a] = await sql<ApprovalRow[]>`
    insert into approvals (run_id, bot_id, thread_id, tool_call_id, kind, action_type, summary, detail)
    values (${run.id}, ${bot.id}, ${run.thread_id}, ${call.id}, ${kind}, ${actionType}, ${summary}, ${json(redact(detail))})
    on conflict (run_id, tool_call_id) do update set summary = excluded.summary
    returning *`;
  await publish({ type: "approval", threadId: run.thread_id, approval: a });
  await notify({
    kind: "attention",
    title: kind === "handoff" ? `${bot.name} behöver att du tar över` : `${bot.name} väntar på ditt godkännande`,
    body: summary,
    url: `/?t=${run.thread_id}`,
    tag: `approval-${a.id}`,
  });
  return a;
}

async function executeToolCalls(run: RunRow, bot: BotRow, thread: ThreadRow, calls: ToolCallBlock[], tools: Tool[], ctx: ToolContext): Promise<"ok" | "waiting"> {
  const results: ToolResultBlock[] = [];
  for (const call of calls) {
    const [existing] = await sql<{ id: string; status: string; result: ToolResultBlock | null }[]>`
      select id, status, result from run_steps where run_id = ${run.id} and tool_call_id = ${call.id}`;
    if (existing?.result && (existing.status === "done" || existing.status === "error")) {
      results.push(existing.result);
      continue;
    }
    const tool = tools.find((t) => t.name === call.name);
    const fail = (content: string): ToolOutput => ({ content, isError: true });
    let out: ToolOutput | null = null;
    let input: any = call.input;
    let title = call.name;
    if (!tool) out = fail(`Okänt verktyg: ${call.name}`);
    else {
      const parsed = tool.schema.safeParse(call.input ?? {});
      if (!parsed.success) out = fail(`Ogiltiga parametrar för ${call.name}: ${parsed.error.message}. Försök igen med korrekta parametrar.`);
      else {
        input = parsed.data;
        try {
          title = tool.title(input);
        } catch {
          /* keep name */
        }
      }
    }

    let stepId = existing?.id;
    if (!stepId) {
      const [s] = await sql<{ id: string }[]>`
        insert into run_steps (run_id, tool_call_id, kind, title, detail, status)
        values (${run.id}, ${call.id}, 'tool', ${title}, ${json(redact({ tool: call.name, input }))}, 'running')
        on conflict (run_id, tool_call_id) where tool_call_id is not null do update set status = 'running'
        returning id`;
      stepId = s.id;
    } else {
      await sql`update run_steps set status = 'running' where id = ${stepId}`;
    }
    const publishStep = async () => {
      const [step] = await sql`select * from run_steps where id = ${stepId}`;
      await publish({ type: "step", threadId: thread.id, runId: run.id, step });
    };
    await publishStep();

    let actionType: string | null = null;
    if (!out && tool) {
      if (tool.name === "request_takeover") {
        const appr = await getApproval(run.id, call.id);
        if (!appr || appr.status === "pending") {
          if (!appr) await createApproval(run, bot, call, "handoff", "handoff", String(input.reason ?? "Ta över webbläsaren"), { reason: input.reason });
          await sql`update run_steps set status = 'waiting' where id = ${stepId}`;
          await publishStep();
          await setStatus(run.id, "waiting_handoff");
          await audit({ botId: bot.id, runId: run.id, threadId: thread.id, tool: call.name, params: input, outcome: "handoff_requested" });
          return "waiting";
        }
        const snap = await ws.snapshot(bot.id).catch(() => null);
        out =
          appr.status === "done"
            ? {
                content:
                  `Användaren tog över datorn och lämnade tillbaka den.${appr.note ? ` Användarens meddelande: ${appr.note}` : ""}` +
                  (snap ? `\n\nAktuell sida i din flik: ${snap.url} – ${snap.title}` : ""),
              }
            : fail(`Användaren avbröt övertagandet${appr.note ? `: ${appr.note}` : ""}.`);
      } else {
        const risk = tool.risk ? await tool.risk(input, ctx) : null;
        if (risk) {
          actionType = risk.actionType;
          const appr = await getApproval(run.id, call.id);
          if (!appr) {
            const policy = await getPolicy(bot.id, risk.actionType);
            if (policy === "deny") {
              out = fail(`Åtgärden blockerades av en regel (${risk.actionType} är nekat för ${bot.name}). Gör inte detta.`);
            } else if (policy !== "allow") {
              await createApproval(run, bot, call, "approval", risk.actionType, title, { tool: call.name, input, reason: risk.reason });
              await sql`update run_steps set status = 'waiting' where id = ${stepId}`;
              await publishStep();
              await setStatus(run.id, "waiting_approval");
              await audit({ botId: bot.id, runId: run.id, threadId: thread.id, tool: call.name, actionType, params: input, outcome: "approval_requested", detail: risk.reason });
              return "waiting";
            }
          } else if (appr.status === "pending") {
            await setStatus(run.id, "waiting_approval");
            return "waiting";
          } else if (appr.status === "denied") {
            out = fail(`Användaren nekade åtgärden${appr.note ? ` ("${appr.note}")` : ""}. Gör inte detta – fråga användaren om du är osäker på hur du ska gå vidare.`);
          }
        }
        if (!out) {
          try {
            out = await tool.run(input, ctx);
          } catch (err) {
            out = fail(`Fel: ${(err as Error)?.message ?? String(err)}`);
          }
        }
      }
    }

    const block: ToolResultBlock = {
      type: "tool_result",
      toolCallId: call.id,
      name: call.name,
      content: redactString(out!.content ?? ""),
      ...(out!.isError ? { isError: true } : {}),
      ...(out!.image ? { image: out!.image } : {}),
    };
    await sql`update run_steps set status = ${out!.isError ? "error" : "done"}, result = ${json(block)},
      screenshot = ${out!.uiImage ?? out!.image ?? null}, finished_at = now() where id = ${stepId}`;
    await publishStep();
    await audit({
      botId: bot.id,
      runId: run.id,
      threadId: thread.id,
      tool: call.name,
      actionType,
      params: input,
      outcome: out!.isError ? "error" : "ok",
      detail: out!.isError ? block.content.slice(0, 500) : null,
    });
    results.push(block);
  }
  await insertMessage({ threadId: thread.id, authorType: "bot", botId: bot.id, runId: run.id, role: "tool", content: results });
  return "ok";
}

async function delegate(run: RunRow, from: BotRow, thread: ThreadRow, slug: string, message: string) {
  const team = await getBots();
  const target = team.find((b) => b.slug.toLowerCase() === slug.toLowerCase() || b.name.toLowerCase() === slug.toLowerCase());
  if (!target) return `Hittar ingen bot som heter @${slug}. Teamet: ${team.map((b) => "@" + b.slug).join(", ")}`;
  if (target.id === from.id) return "Du kan inte delegera till dig själv.";
  if (run.depth >= config.maxBotChainDepth) return "För många överlämningar i rad – gör klart själv eller fråga användaren.";
  await addBotToThread(thread.id, target.id);
  await insertMessage({
    threadId: thread.id,
    authorType: "bot",
    botId: from.id,
    runId: run.id,
    role: "note",
    content: [{ type: "text", text: `@${target.slug} ${message}` }],
  });
  await ensureRun({ threadId: thread.id, botId: target.id, trigger: "delegation", parentRunId: run.id, depth: run.depth + 1 });
  return `Uppgiften är överlämnad till ${target.name} (@${target.slug}). Hen svarar i tråden och @-nämner dig om något behövs. Avsluta din tur om du inte har mer att göra.`;
}

async function finish(run: RunRow, status: "done" | "error" | "cancelled", error?: string, seenSeq?: bigint) {
  const [last] = await sql<MessageRow[]>`
    select * from messages where run_id = ${run.id} and role = 'assistant' order by seq desc limit 1`;
  const finalText = last ? textOf(last.content) : "";
  await sql`update runs set status = ${status}, error = ${error ?? null}, summary = ${finalText.slice(0, 500)},
    finished_at = now(), started_at = coalesce(started_at, now()) where id = ${run.id}`;
  await sql`update run_steps set status = 'cancelled' where run_id = ${run.id} and status in ('running', 'waiting')`;
  await sql`update approvals set status = 'denied', note = 'körningen avslutades' where run_id = ${run.id} and status = 'pending'`;
  const updated = await publishRun(run.id);
  await publishThread(run.thread_id);
  if (!updated) return;
  const bot = await getBot(run.bot_id);

  if (status === "done") {
    await dispatchMentions(updated, finalText);
    // A human message may have slipped in between the last check and the status update.
    // (Teammate mentions are handled by their own dispatchMentions, which respects the chain depth.)
    const team = await getBots();
    const messages = await loadThreadMessages(run.thread_id);
    if (bot && responseReason(messages, bot, team, seenSeq) === "human") await ensureRun({ threadId: run.thread_id, botId: bot.id, trigger: "chat" });
  }

  const started = updated.started_at ? new Date(updated.started_at).getTime() : Date.now();
  const long = Date.now() - started > 30_000;
  if (bot && (updated.trigger !== "chat" || long || status === "error")) {
    await notify({
      kind: status === "error" ? "attention" : "done",
      title: status === "error" ? `${bot.name} stötte på ett problem` : `${bot.name} är klar`,
      body: (error ?? finalText).replace(/[#*_`>]/g, "").slice(0, 180) || "Klar.",
      url: `/?t=${run.thread_id}`,
      tag: `run-${run.id}`,
    });
  }
}
