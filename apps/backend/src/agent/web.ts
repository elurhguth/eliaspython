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

export async function webFetch(url: string, maxChars = 20_000) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Crew/0.1", accept: "text/html,application/json,text/plain,*/*" },
  });
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const text = type.includes("html") ? htmlToText(body) : body;
  return {
    status: res.status,
    url: res.url,
    contentType: type,
    text: text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text,
  };
}
