"use client";

import { ArrowLeft, Download, FileText, Folder, Hand, Maximize2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, fileUrl } from "@/lib/api";
import { bytes, cx, timeAgo } from "@/lib/format";
import type { Approval, Bot, Step } from "@/lib/types";
import { Button, Empty, IconButton, Input } from "./ui";
import { toolIcon } from "./Timeline";

type Tab = "live" | "steps" | "files";

function vncUrl(viewOnly: boolean) {
  const p = new URLSearchParams({
    view_only: viewOnly ? "1" : "0",
    path: "vnc/websockify",
  });
  return `/vnc/crew-view.html?${p}`;
}

export function ComputerPanel({
  steps,
  handoff,
  bot,
  onClose,
  takeover,
  setTakeover,
}: {
  steps: Step[];
  handoff: Approval | null;
  bot?: Bot;
  onClose: () => void;
  takeover: boolean;
  setTakeover: (v: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("live");
  const [note, setNote] = useState("");
  const [zoom, setZoom] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  useEffect(() => {
    if (handoff) {
      setTab("live");
      setTakeover(true);
    }
  }, [handoff, setTakeover]);

  async function giveBack(done: boolean) {
    if (handoff) await api.post(`/api/approvals/${handoff.id}/handoff`, { done, note: note || undefined });
    setNote("");
    setTakeover(false);
  }

  const withShots = steps.filter((s) => s.screenshot).slice(-30).reverse();

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex items-center gap-1 border-b border-line px-3 py-2">
        <div className="flex rounded-xl bg-panel2 p-0.5 text-[13px]">
          {(
            [
              ["live", "Live"],
              ["steps", "Steg"],
              ["files", "Filer"],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={cx("rounded-lg px-3 py-1.5 transition-colors", tab === k ? "bg-raise text-ink" : "text-muted hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center">
          {tab === "live" && (
            <>
              <IconButton label="Ladda om vyn" onClick={() => setFrameKey((k) => k + 1)}>
                <RefreshCw size={15} />
              </IconButton>
              <IconButton label="Öppna i eget fönster" onClick={() => window.open(vncUrl(!takeover), "_blank")}>
                <Maximize2 size={15} />
              </IconButton>
            </>
          )}
          <IconButton label="Stäng" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
      </div>

      {tab === "live" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {takeover ? (
            <div className="border-b border-ember/30 bg-ember/10 px-3 py-2.5 text-sm">
              <div className="flex items-start gap-2">
                <Hand size={16} className="mt-0.5 shrink-0 text-ember" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">Du styr datorn</div>
                  <div className="text-xs text-ink2">
                    {handoff ? handoff.summary : "Boten är pausad i webbläsaren medan du arbetar."} Lösenord du skriver här syns aldrig för botarna.
                  </div>
                </div>
              </div>
              {handoff ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Meddelande till boten (valfritt)" className="h-8 min-w-0 flex-1 text-xs" />
                  <Button size="sm" variant="primary" onClick={() => giveBack(true)}>
                    Klar – lämna tillbaka
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => giveBack(false)}>
                    Avbryt
                  </Button>
                </div>
              ) : (
                <div className="mt-2">
                  <Button size="sm" onClick={() => setTakeover(false)}>
                    Sluta styra
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs text-muted">
              <span>Livebild av den delade datorn (endast visning)</span>
              <button onClick={() => setTakeover(true)} className="rounded-lg px-2 py-1 text-ink2 hover:bg-raise">
                Ta kontroll
              </button>
            </div>
          )}
          <div className="relative min-h-0 flex-1 bg-black">
            <iframe key={`${frameKey}-${takeover}`} src={vncUrl(!takeover)} className="absolute inset-0 h-full w-full border-0" title="Datorn" allow="clipboard-read; clipboard-write" />
          </div>
        </div>
      )}

      {tab === "steps" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {!steps.length && <Empty title="Inga steg än" text="När en bot jobbar syns varje steg här, med skärmdumpar från webbläsaren." />}
          <div className="space-y-1">
            {[...steps].reverse().map((s) => (
              <div key={s.id} className="rounded-xl border border-line bg-panel2 p-2.5">
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="text-muted">{toolIcon(s.detail?.tool ?? "")}</span>
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className={cx("text-[11px]", s.status === "error" ? "text-danger" : s.status === "running" || s.status === "waiting" ? "text-ember" : "text-faint")}>
                    {s.status === "running" ? "pågår" : s.status === "waiting" ? "väntar" : timeAgo(s.created_at)}
                  </span>
                </div>
                {s.screenshot && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={fileUrl(s.screenshot)} alt="" onClick={() => setZoom(s.screenshot)} className="mt-2 w-full cursor-zoom-in rounded-lg border border-line" loading="lazy" />
                )}
              </div>
            ))}
          </div>
          {!withShots.length && steps.length > 0 && <div className="mt-3 text-center text-xs text-faint">Inga skärmdumpar i den här tråden.</div>}
        </div>
      )}

      {tab === "files" && <FileBrowser />}

      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={fileUrl(zoom)} alt="" className="max-h-full max-w-full rounded-xl" />
        </div>
      )}
    </div>
  );
}

interface Entry {
  name: string;
  path: string;
  type: string;
  size: number;
  modified: string;
}

function FileBrowser() {
  const [path, setPath] = useState("/home/crew");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async (p: string) => {
    setError("");
    try {
      const r = await api.get<{ path: string; entries: Entry[] }>(`/api/workstation/files?path=${encodeURIComponent(p)}`);
      setEntries(r.entries);
      setPath(r.path);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load("/home/crew");
  }, [load]);
  const up = path.split("/").slice(0, -1).join("/") || "/home/crew";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <IconButton label="Upp" onClick={() => load(up)} disabled={path === "/home/crew"} className="h-7 w-7">
          <ArrowLeft size={14} />
        </IconButton>
        <span className="truncate font-mono text-muted">{path.replace("/home/crew", "~")}</span>
        <IconButton label="Uppdatera" onClick={() => load(path)} className="ml-auto h-7 w-7">
          <RefreshCw size={13} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {error && <div className="p-3 text-sm text-danger">{error}</div>}
        {entries?.length === 0 && <Empty title="Tom mapp" />}
        {entries?.map((e) =>
          e.type === "dir" ? (
            <button key={e.path} onClick={() => load(e.path)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-panel2">
              <Folder size={15} className="text-ember" />
              <span className="flex-1 truncate">{e.name}</span>
            </button>
          ) : (
            <a
              key={e.path}
              href={`/api/workstation/download?path=${encodeURIComponent(e.path)}`}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-panel2"
            >
              <FileText size={15} className="text-muted" />
              <span className="flex-1 truncate">{e.name}</span>
              <span className="text-xs text-faint">{bytes(e.size)}</span>
              <Download size={13} className="text-faint" />
            </a>
          ),
        )}
      </div>
    </div>
  );
}
