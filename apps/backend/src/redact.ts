import { secretValues } from "./config.js";

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{10,}/g,
  /xai-[A-Za-z0-9_\-]{10,}/g,
  /sk-[A-Za-z0-9_\-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(Bearer\s+)[A-Za-z0-9._\-]{16,}/gi,
  /("?(?:password|passwd|pwd|secret|token|api[_-]?key|authorization)"?\s*[:=]\s*"?)[^"\s,}]{4,}/gi,
];

const SECRET_KEY = /^(.*[_-])?(pass(word)?|passwd|secret|token|api[_-]?key|apikey|authorization|otp|pin|cookie)$/i;

/** Mask secrets in a string. */
export function redactString(s: string): string {
  let out = s;
  for (const v of secretValues()) out = out.split(v).join("••••");
  for (const re of PATTERNS) {
    out = out.replace(re, (m, prefix) => (typeof prefix === "string" && m.startsWith(prefix) ? `${prefix}••••` : "••••"));
  }
  return out;
}

/** Deep-redact any JSON-ish value. Keys that look secret are always masked. */
export function redact<T>(value: T): T {
  const seen = new WeakSet();
  const walk = (v: any, key?: string): any => {
    if (typeof v === "string") {
      if (key && SECRET_KEY.test(key) && v.length > 0) return "••••";
      return redactString(v);
    }
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v)) return "[binary]";
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
      if (Array.isArray(v)) return v.map((x) => walk(x));
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, k);
      return out;
    }
    return v;
  };
  return walk(value);
}
