"use client";

import { X } from "lucide-react";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import type { Bot } from "@/lib/types";
import { cx } from "@/lib/format";

export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" className={className} aria-label="Crew">
      <rect width="512" height="512" rx="112" fill="#181b1f" />
      <g stroke="#e8a25c" strokeOpacity="0.4" strokeWidth="16" strokeLinecap="round">
        <line x1="256" y1="168" x2="168" y2="330" />
        <line x1="256" y1="168" x2="344" y2="330" />
        <line x1="168" y1="330" x2="344" y2="330" />
      </g>
      <circle cx="256" cy="168" r="62" fill="#e8a25c" />
      <circle cx="168" cy="330" r="50" fill="#ece8e2" />
      <circle cx="344" cy="330" r="50" fill="#7cb7a6" />
    </svg>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none select-none",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm",
        variant === "primary" && "bg-ember text-[#1a1208] hover:bg-[#f0b373]",
        variant === "secondary" && "bg-raise text-ink border border-line2 hover:bg-[#262b31]",
        variant === "ghost" && "text-ink2 hover:bg-raise hover:text-ink",
        variant === "subtle" && "bg-panel2 text-ink2 border border-line hover:text-ink hover:bg-raise",
        variant === "danger" && "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
        className,
      )}
    />
  );
}

export function IconButton({ className, label, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-raise hover:text-ink disabled:opacity-40",
        className,
      )}
    />
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cx(
        "h-10 w-full rounded-xl border border-line bg-panel2 px-3 text-sm text-ink placeholder:text-faint outline-none focus:border-ember/60",
        className,
      )}
    />
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={cx(
        "w-full rounded-xl border border-line bg-panel2 px-3 py-2.5 text-sm text-ink placeholder:text-faint outline-none focus:border-ember/60",
        className,
      )}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cx("h-10 w-full rounded-xl border border-line bg-panel2 px-3 text-sm text-ink outline-none focus:border-ember/60", className)}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[13px] font-medium text-ink2">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx("relative h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-ember" : "bg-line2")}
    >
      <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all", checked ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        className={cx(
          "flex max-h-[92dvh] w-full flex-col rounded-t-3xl border border-line bg-panel shadow-2xl sm:rounded-3xl",
          wide ? "sm:max-w-3xl" : "sm:max-w-lg",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="text-base font-semibold">{title}</div>
          <IconButton label="Stäng" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="safe-bottom flex justify-end gap-2 border-t border-line px-5 pt-3">{footer}</div>}
      </div>
    </div>
  );
}

export function BotAvatar({ bot, size = 32, status }: { bot?: Pick<Bot, "avatar" | "color" | "name"> | null; size?: number; status?: string }) {
  const color = bot?.color ?? "#5d636b";
  const isImg = bot?.avatar?.startsWith("data:") || bot?.avatar?.startsWith("http");
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span
        className="inline-flex h-full w-full items-center justify-center overflow-hidden rounded-full"
        style={{ background: `${color}26`, boxShadow: `inset 0 0 0 1px ${color}55`, fontSize: size * 0.5 }}
      >
        {isImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={bot!.avatar} alt="" className="h-full w-full object-cover" />
        ) : (
          bot?.avatar || (bot?.name?.[0] ?? "?")
        )}
      </span>
      {status && status !== "idle" && (
        <span
          className={cx(
            "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-panel",
            status === "working" && "pulse-dot bg-ember",
            status === "queued" && "bg-muted",
            status === "needs_you" && "bg-danger",
          )}
        />
      )}
    </span>
  );
}

export function AvatarStack({ bots, size = 22 }: { bots: (Bot | undefined)[]; size?: number }) {
  return (
    <span className="flex -space-x-1.5">
      {bots.filter(Boolean).slice(0, 4).map((b) => (
        <span key={b!.id} className="rounded-full ring-2 ring-panel">
          <BotAvatar bot={b} size={size} />
        </span>
      ))}
    </span>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg className="animate-spin text-muted" width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ember" | "danger" | "ok" | "sage" }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium",
        tone === "muted" && "bg-raise text-muted",
        tone === "ember" && "bg-ember/15 text-ember",
        tone === "danger" && "bg-danger/15 text-danger",
        tone === "ok" && "bg-ok/15 text-ok",
        tone === "sage" && "bg-sage/15 text-sage",
      )}
    >
      {children}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-2xl border border-line bg-panel", className)}>{children}</div>;
}

export function Empty({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <div className="font-medium">{title}</div>
      {text && <div className="mt-1 max-w-sm text-sm text-muted">{text}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
