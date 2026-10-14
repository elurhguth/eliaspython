"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { ACTIVE, type Approval, type Bootstrap, type Bot, type CrewEvent, type Run, type Thread } from "./types";

type Listener = (e: CrewEvent) => void;

interface CrewState extends Bootstrap {
  activeRuns: Record<string, Run>;
  connected: boolean;
  refresh(): Promise<void>;
  refreshBots(): Promise<void>;
  on(listener: Listener): () => void;
  botById(id: string | null | undefined): Bot | undefined;
  upsertThread(t: Thread): void;
}

const Ctx = createContext<CrewState | null>(null);

export function useCrew() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCrew outside CrewProvider");
  return c;
}

export function CrewProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [activeRuns, setActiveRuns] = useState<Record<string, Run>>({});
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());

  const refresh = useCallback(async () => {
    const [b, runs] = await Promise.all([api.get<Bootstrap>("/api/bootstrap"), api.get<Run[]>("/api/runs?status=active")]);
    setData(b);
    setActiveRuns(Object.fromEntries(runs.map((r) => [r.id, r])));
  }, []);

  const refreshBots = useCallback(async () => {
    const bots = await api.get<Bot[]>("/api/bots");
    setData((d) => (d ? { ...d, bots } : d));
  }, []);

  const upsertThread = useCallback((t: Thread) => {
    setData((d) => {
      if (!d) return d;
      if (t.deleted || t.archived) return { ...d, threads: d.threads.filter((x) => x.id !== t.id) };
      const others = d.threads.filter((x) => x.id !== t.id);
      return { ...d, threads: [t, ...others].sort((a, b) => b.updated_at.localeCompare(a.updated_at)) };
    });
  }, []);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  // One SSE connection for the whole app.
  useEffect(() => {
    if (!data) return;
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      es = new EventSource("/api/events");
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (!closed) retry = setTimeout(() => {
          refresh().catch(() => {});
          connect();
        }, 3000);
      };
      es.onmessage = (msg) => {
        let e: CrewEvent;
        try {
          e = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (e.type === "run") {
          setActiveRuns((prev) => {
            const next = { ...prev };
            if (ACTIVE.includes(e.run.status)) next[e.run.id] = e.run;
            else delete next[e.run.id];
            return next;
          });
        } else if (e.type === "thread") {
          upsertThread(e.thread);
        } else if (e.type === "approval") {
          const a = e.approval;
          setData((d) => {
            if (!d) return d;
            const others = d.approvals.filter((x) => x.id !== a.id);
            return { ...d, approvals: a.status === "pending" ? [...others, a] : others };
          });
        } else if (e.type === "bots") {
          refreshBots().catch(() => {});
        }
        for (const l of listeners.current) l(e);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data]);

  const value = useMemo<CrewState | null>(() => {
    if (!data) return null;
    const byId = new Map(data.bots.map((b) => [b.id, b]));
    return {
      ...data,
      activeRuns,
      connected,
      refresh,
      refreshBots,
      upsertThread,
      on(l) {
        listeners.current.add(l);
        return () => listeners.current.delete(l);
      },
      botById: (id) => (id ? byId.get(id) : undefined),
    };
  }, [data, activeRuns, connected, refresh, refreshBots, upsertThread]);

  if (!value) return <>{fallback}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCrewEvent(listener: Listener, deps: unknown[]) {
  const { on } = useCrew();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => on(listener), deps);
}

export function botStatus(bot: Bot, activeRuns: Record<string, Run>, approvals: Approval[]) {
  if (approvals.some((a) => a.bot_id === bot.id)) return "needs_you" as const;
  const runs = Object.values(activeRuns).filter((r) => r.bot_id === bot.id);
  if (runs.some((r) => r.status === "running")) return "working" as const;
  if (runs.length) return "queued" as const;
  return "idle" as const;
}
