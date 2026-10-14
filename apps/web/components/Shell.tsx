"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Brain, CalendarClock, Menu, MessageSquarePlus, Plus, ScrollText, Settings, ShieldCheck } from "lucide-react";
import { CrewProvider, botStatus, useCrew } from "@/lib/store";
import { registerSW } from "@/lib/push";
import { cx, timeAgo } from "@/lib/format";
import { AvatarStack, BotAvatar, Logo, Spinner } from "./ui";
import { BotEditor } from "./BotEditor";
import type { Bot } from "@/lib/types";

export function Shell({ children }: { children: ReactNode }) {
  useEffect(() => {
    registerSW();
  }, []);
  return (
    <CrewProvider
      fallback={
        <div className="flex h-dvh items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <Logo size={44} />
            <Spinner />
          </div>
        </div>
      }
    >
      <Suspense>
        <Layout>{children}</Layout>
      </Suspense>
    </CrewProvider>
  );
}

function Layout({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
  const params = useSearchParams();
  useEffect(() => setDrawer(false), [pathname, params]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-[272px] shrink-0 border-r border-line bg-panel md:flex">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setDrawer(false)}>
          <div className="absolute inset-0 bg-black/60" />
          <aside className="safe-top absolute inset-y-0 left-0 flex w-[86%] max-w-[320px] border-r border-line bg-panel" onClick={(e) => e.stopPropagation()}>
            <Sidebar />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileBar onMenu={() => setDrawer(true)} />
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}

function MobileBar({ onMenu }: { onMenu: () => void }) {
  const { approvals } = useCrew();
  return (
    <div className="safe-top flex items-center gap-2 border-b border-line bg-panel px-3 py-2 md:hidden">
      <button onClick={onMenu} className="relative rounded-xl p-2 text-ink2 hover:bg-raise" aria-label="Meny">
        <Menu size={20} />
        {approvals.length > 0 && <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-danger" />}
      </button>
      <Link href="/" className="flex items-center gap-2">
        <Logo size={24} />
        <span className="font-semibold tracking-tight">Crew</span>
      </Link>
    </div>
  );
}

function Sidebar() {
  const { bots, threads, approvals, activeRuns, workstation, connected } = useCrew();
  const params = useSearchParams();
  const pathname = usePathname();
  const currentThread = params.get("t");
  const currentBot = params.get("bot");
  const [editing, setEditing] = useState<Bot | "new" | null>(null);
  const botById = new Map(bots.map((b) => [b.id, b]));
  const groupAndRoutine = threads.slice(0, 40);

  return (
    <div className="flex min-h-0 w-full flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo size={28} />
          <span className="text-[17px] font-semibold tracking-tight">Crew</span>
        </Link>
        <span
          className={cx("h-2 w-2 rounded-full", connected && workstation.ok ? "bg-ok" : connected ? "bg-ember" : "bg-danger")}
          title={connected ? (workstation.ok ? "Ansluten · datorn är igång" : "Ansluten · datorn svarar inte") : "Frånkopplad"}
        />
      </div>

      <div className="px-3 pb-2">
        <Link
          href="/"
          className="flex h-10 items-center gap-2 rounded-xl border border-line bg-panel2 px-3 text-sm text-ink2 transition-colors hover:border-line2 hover:text-ink"
        >
          <MessageSquarePlus size={16} /> Ny uppgift
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <SectionTitle
          action={
            <button onClick={() => setEditing("new")} className="rounded-lg p-1 text-muted hover:bg-raise hover:text-ink" aria-label="Ny bot" title="Ny bot">
              <Plus size={15} />
            </button>
          }
        >
          Bots
        </SectionTitle>
        <div className="space-y-0.5">
          {bots.map((b) => {
            const status = botStatus(b, activeRuns, approvals);
            const active = currentBot === b.id;
            return (
              <div key={b.id} className="group relative">
                <Link
                  href={`/?bot=${b.id}`}
                  className={cx("flex items-center gap-3 rounded-xl px-2 py-2 transition-colors", active ? "bg-raise" : "hover:bg-panel2")}
                >
                  <BotAvatar bot={b} size={34} status={status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                      {b.name}
                      {b.is_lead && <span className="text-[10px] text-ember">★</span>}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {status === "working" ? "Arbetar…" : status === "needs_you" ? "Behöver dig" : status === "queued" ? "Väntar…" : b.role || "Bot"}
                    </div>
                  </div>
                </Link>
                <button
                  onClick={() => setEditing(b)}
                  className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-lg p-1.5 text-muted hover:bg-raise hover:text-ink group-hover:block"
                  aria-label={`Redigera ${b.name}`}
                >
                  <Settings size={14} />
                </button>
              </div>
            );
          })}
        </div>

        <SectionTitle>Chattar</SectionTitle>
        {groupAndRoutine.length === 0 && <div className="px-3 py-2 text-xs text-faint">Inga chattar än.</div>}
        <div className="space-y-0.5">
          {groupAndRoutine.map((t) => {
            const tb = t.bot_ids.map((id) => botById.get(id));
            const running = t.last_run_status === "running" || t.last_run_status === "queued";
            const waiting = approvals.some((a) => a.thread_id === t.id);
            return (
              <Link
                key={t.id}
                href={`/?t=${t.id}`}
                className={cx(
                  "flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm transition-colors",
                  currentThread === t.id ? "bg-raise text-ink" : "text-ink2 hover:bg-panel2",
                )}
              >
                <AvatarStack bots={tb} size={20} />
                <span className="min-w-0 flex-1 truncate">{t.title || (t.kind === "group" ? "Gruppchatt" : "Ny chatt")}</span>
                {waiting ? (
                  <span className="h-2 w-2 rounded-full bg-danger" />
                ) : running ? (
                  <span className="pulse-dot h-2 w-2 rounded-full bg-ember" />
                ) : (
                  <span className="text-[11px] text-faint">{timeAgo(t.updated_at)}</span>
                )}
              </Link>
            );
          })}
        </div>
      </div>

      <nav className="safe-bottom border-t border-line px-2 pt-2">
        <NavItem href="/approvals" icon={<ShieldCheck size={16} />} label="Godkännanden" active={pathname === "/approvals"} badge={approvals.length} />
        <NavItem href="/routines" icon={<CalendarClock size={16} />} label="Routines" active={pathname === "/routines"} />
        <NavItem href="/memory" icon={<Brain size={16} />} label="Minne & skills" active={pathname === "/memory"} />
        <NavItem href="/log" icon={<ScrollText size={16} />} label="Logg" active={pathname === "/log"} />
        <NavItem href="/settings" icon={<Settings size={16} />} label="Inställningar" active={pathname === "/settings"} />
      </nav>

      <BotEditor bot={editing === "new" ? null : editing} open={editing !== null} onClose={() => setEditing(null)} />
    </div>
  );
}

function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-1 mt-4 flex items-center justify-between px-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">{children}</span>
      {action}
    </div>
  );
}

function NavItem({ href, icon, label, active, badge }: { href: string; icon: ReactNode; label: string; active?: boolean; badge?: number }) {
  return (
    <Link
      href={href}
      className={cx("flex h-9 items-center gap-2.5 rounded-xl px-2.5 text-sm transition-colors", active ? "bg-raise text-ink" : "text-ink2 hover:bg-panel2")}
    >
      <span className="text-muted">{icon}</span>
      <span className="flex-1">{label}</span>
      {!!badge && <span className="rounded-full bg-danger px-1.5 text-[11px] font-semibold text-white">{badge}</span>}
    </Link>
  );
}

