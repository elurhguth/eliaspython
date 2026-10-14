import { lookup } from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(query: string, count = 8): Promise<SearchResult[]> {
  if (config.searxngUrl) {
    const url = new URL("/search", config.searxngUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "x-forwarded-for": "127.0.0.1" } });
    if (!res.ok) throw new Error(`SearXNG ${res.status}`);
    const body = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
    return (body.results ?? []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
  }
  if (config.braveApiKey) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    const res = await fetch(url, {
      headers: { accept: "application/json", "x-subscription-token": config.braveApiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Brave search ${res.status}`);
    const body = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
    return (body.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? "" }));
  }
  throw new Error("Ingen sökmotor konfigurerad (SEARXNG_URL eller BRAVE_API_KEY). Använd webbläsaren istället.");
}

/** Very small HTML → text conversion, good enough for reading articles and docs. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** True for loopback, private, link-local (cloud metadata), CGNAT and unique-local addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

/** Refuse URLs that point into the local network (SSRF guard for the server-side fetch tool). */
async function assertPublicUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Bara http(s)-adresser stöds");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string }[];
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch (err) {
    // Behind an outbound HTTP proxy the container may have no DNS – the proxy resolves instead.
    if (process.env.HTTPS_PROXY || process.env.https_proxy) return;
    throw err;
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`${u.hostname} pekar på ett internt nätverk och blockeras av säkerhetsskäl. Använd webbläsaren om du verkligen behöver den.`);
  }
}

export async function webFetch(url: string, maxChars = 20_000) {
  let current = /^[a-z]+:/i.test(url) ? url : `https://${url}`;
  let res: Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current);
    res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Crew/0.1", accept: "text/html,application/json,text/plain,*/*" },
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    break;
  }
  if (!res) throw new Error("Ingen respons");
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const text = type.includes("html") ? htmlToText(body) : body;
  return {
    status: res.status,
    url: current,
    contentType: type,
    text: text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text,
  };
}
