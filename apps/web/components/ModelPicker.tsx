"use client";

import { Check, ChevronDown, Cpu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCrew } from "@/lib/store";
import { cx } from "@/lib/format";

export function modelLabel(provider: string, model: string) {
  if (provider === "demo") return "Demo (offline)";
  return model;
}

/** Compact Grok-style model selector (used in the composer and the bot editor). */
export function ModelPicker({
  provider,
  model,
  onChange,
  compact,
  up,
}: {
  provider: string;
  model: string;
  onChange: (provider: string, model: string) => void;
  compact?: boolean;
  up?: boolean;
}) {
  const { models } = useCrew();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const groups = models.providers.filter((p) => p.configured);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "flex items-center gap-1.5 rounded-xl text-ink2 transition-colors hover:bg-raise hover:text-ink",
          compact ? "h-8 px-2 text-xs" : "h-10 w-full border border-line bg-panel2 px-3 text-sm",
        )}
      >
        <Cpu size={compact ? 13 : 15} className="text-muted" />
        <span className={cx("truncate", compact ? "max-w-[140px]" : "flex-1 text-left")}>{modelLabel(provider, model)}</span>
        <ChevronDown size={13} className="text-muted" />
      </button>
      {open && (
        <div
          className={cx(
            "absolute z-30 max-h-80 w-72 overflow-y-auto rounded-2xl border border-line bg-panel p-1.5 shadow-2xl",
            up ? "bottom-full mb-2" : "top-full mt-2",
            compact ? "right-0" : "left-0",
          )}
        >
          {groups.map((g) => (
            <div key={g.id} className="mb-1">
              <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
                {g.label}
                {g.error && <span className="ml-1 normal-case text-danger" title={g.error}>(kunde inte lista)</span>}
              </div>
              {models.models
                .filter((m) => m.provider === g.id)
                .map((m) => {
                  const sel = m.provider === provider && m.id === model;
                  return (
                    <button
                      key={m.provider + m.id}
                      type="button"
                      onClick={() => {
                        onChange(m.provider, m.id);
                        setOpen(false);
                      }}
                      className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-raise", sel && "text-ember")}
                    >
                      <span className="flex-1 truncate">{m.label}</span>
                      {sel && <Check size={14} />}
                    </button>
                  );
                })}
            </div>
          ))}
          <div className="border-t border-line p-2">
            <div className="mb-1 text-[11px] text-faint">Annan modell (provider:modell)</div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const [p, ...rest] = custom.split(":");
                if (p && rest.length) {
                  onChange(p.trim(), rest.join(":").trim());
                  setOpen(false);
                }
              }}
            >
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="xai:grok-4"
                className="h-8 w-full rounded-lg border border-line bg-panel2 px-2 text-xs outline-none focus:border-ember/60"
              />
            </form>
          </div>
          {models.providers.some((p) => !p.configured && p.id !== "openai") && (
            <div className="px-2.5 pb-1.5 text-[11px] text-faint">
              Ej konfigurerade: {models.providers.filter((p) => !p.configured && p.id !== "openai").map((p) => p.label).join(", ")} – lägg till API-nyckel i .env
            </div>
          )}
        </div>
      )}
    </div>
  );
}
