import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

/**
 * All bots share ONE Chromium (same cookies, logins and profile) but each bot
 * drives its own tab so that two bots working at once do not fight over the
 * same page. The live view (noVNC) shows whichever tab was used last.
 */

const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";

let browser: Browser | null = null;
let connecting: Promise<Browser> | null = null;
const pages = new Map<string, Page>();

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (connecting) return connecting;
  connecting = (async () => {
    let lastErr: unknown;
    for (let i = 0; i < 30; i++) {
      try {
        const b = await chromium.connectOverCDP(CDP_URL);
        b.on("disconnected", () => {
          browser = null;
          pages.clear();
        });
        browser = b;
        return b;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`Could not connect to Chromium at ${CDP_URL}: ${String(lastErr)}`);
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function getContext(): Promise<BrowserContext> {
  const b = await getBrowser();
  const ctx = b.contexts()[0];
  if (!ctx) throw new Error("Chromium has no default context");
  return ctx;
}

export async function pageFor(owner: string): Promise<Page> {
  const existing = pages.get(owner);
  if (existing && !existing.isClosed()) return existing;
  const ctx = await getContext();
  // Reuse the initial blank tab for the first owner instead of leaving it around.
  const blank = ctx.pages().find((p) => p.url() === "about:blank" && ![...pages.values()].includes(p));
  const page = blank ?? (await ctx.newPage());
  page.setDefaultTimeout(15_000);
  pages.set(owner, page);
  page.on("close", () => pages.delete(owner));
  return page;
}

async function front(page: Page) {
  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }
}

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  elements: string;
}

/** Text snapshot of the page with numbered interactive elements the model can refer to. */
export async function snapshot(page: Page, maxText = 6000): Promise<Snapshot> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const data = await page.evaluate((maxTextLen: number) => {
    const doc = (globalThis as any).document;
    const win = globalThis as any;
    const selector = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "textarea",
      "select",
      "summary",
      "[role=button]",
      "[role=link]",
      "[role=tab]",
      "[role=menuitem]",
      "[role=checkbox]",
      "[role=option]",
      "[contenteditable=''], [contenteditable=true]",
      "[onclick]",
    ].join(",");
    doc.querySelectorAll("[data-crew-ref]").forEach((el: any) => el.removeAttribute("data-crew-ref"));
    const lines: string[] = [];
    let n = 0;
    for (const el of Array.from(doc.querySelectorAll(selector)) as any[]) {
      const rect = el.getBoundingClientRect();
      const style = win.getComputedStyle(el);
      if (rect.width < 1 || rect.height < 1 || style.visibility === "hidden" || style.display === "none") continue;
      if (n >= 250) break;
      n++;
      el.setAttribute("data-crew-ref", String(n));
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type");
      const label =
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.getAttribute("name") ||
        (el.innerText || el.value || "").trim().replace(/\s+/g, " ");
      const href = tag === "a" ? ` -> ${el.getAttribute("href")}`.slice(0, 120) : "";
      const value =
        (tag === "input" || tag === "textarea") && type !== "password" && el.value ? ` value="${String(el.value).slice(0, 60)}"` : "";
      const inView = rect.bottom >= 0 && rect.top <= win.innerHeight ? "" : " (off-screen)";
      lines.push(`[${n}] ${tag}${type ? `[${type}]` : ""} "${String(label).slice(0, 80)}"${value}${href}${inView}`);
    }
    const text = (doc.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
    return {
      url: win.location.href,
      title: doc.title,
      text: text.length > maxTextLen ? text.slice(0, maxTextLen) + "\n…(truncated)" : text,
      elements: lines.join("\n"),
    };
  }, maxText);
  return data;
}

function refLocator(page: Page, ref: number | string) {
  return page.locator(`[data-crew-ref="${ref}"]`).first();
}

export interface ActionInput {
  action: "navigate" | "click" | "type" | "press" | "scroll" | "back" | "forward" | "reload" | "wait" | "select";
  url?: string;
  ref?: number | string;
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  key?: string;
  submit?: boolean;
  direction?: "up" | "down";
  amount?: number;
  value?: string;
  ms?: number;
}

export class PasswordFieldError extends Error {}

export async function act(owner: string, input: ActionInput): Promise<Snapshot> {
  const page = await pageFor(owner);
  await front(page);
  const target = () => {
    if (input.ref !== undefined && input.ref !== null && input.ref !== "") return refLocator(page, input.ref);
    if (input.selector) return page.locator(input.selector).first();
    return null;
  };
  switch (input.action) {
    case "navigate": {
      let url = (input.url ?? "").trim();
      if (!url) throw new Error("url is required");
      if (!/^[a-z]+:/i.test(url)) url = "https://" + url;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      break;
    }
    case "click": {
      const loc = target();
      if (loc) await loc.click({ timeout: 10_000 });
      else if (typeof input.x === "number" && typeof input.y === "number") await page.mouse.click(input.x, input.y);
      else throw new Error("click needs ref, selector or x/y");
      break;
    }
    case "type": {
      const loc = target();
      if (!loc) throw new Error("type needs ref or selector");
      const type = await loc.getAttribute("type").catch(() => null);
      const autocomplete = await loc.getAttribute("autocomplete").catch(() => null);
      if (type === "password" || autocomplete === "one-time-code") {
        throw new PasswordFieldError(
          "This is a password/2FA field. Bots never type secrets – use request_takeover so the user can enter it.",
        );
      }
      await loc.fill(input.text ?? "", { timeout: 10_000 });
      if (input.submit) await loc.press("Enter");
      break;
    }
    case "select": {
      const loc = target();
      if (!loc) throw new Error("select needs ref or selector");
      await loc.selectOption(input.value ?? input.text ?? "");
      break;
    }
    case "press":
      await page.keyboard.press(input.key ?? "Enter");
      break;
    case "scroll": {
      const amount = (input.amount ?? 600) * (input.direction === "up" ? -1 : 1);
      await page.mouse.wheel(0, amount);
      break;
    }
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      break;
    case "forward":
      await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
      break;
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded" });
      break;
    case "wait":
      await page.waitForTimeout(Math.min(input.ms ?? 1000, 15_000));
      break;
    default:
      throw new Error(`Unknown action ${(input as any).action}`);
  }
  // Let the page settle a little so the snapshot reflects the result.
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  return snapshot(page);
}

export async function screenshot(owner: string, fullPage = false): Promise<Buffer> {
  const page = await pageFor(owner);
  await front(page);
  return page.screenshot({ type: "jpeg", quality: 70, fullPage });
}

export async function describe(owner: string): Promise<Snapshot> {
  const page = await pageFor(owner);
  return snapshot(page);
}

export async function tabs() {
  const ctx = await getContext();
  const owners = new Map<Page, string>();
  for (const [o, p] of pages) owners.set(p, o);
  return Promise.all(
    ctx.pages().map(async (p) => ({ url: p.url(), title: await p.title().catch(() => ""), owner: owners.get(p) ?? null })),
  );
}

export async function closeOwner(owner: string) {
  const page = pages.get(owner);
  if (page) await page.close().catch(() => {});
  pages.delete(owner);
}

export async function browserHealthy(): Promise<boolean> {
  try {
    await getBrowser();
    return true;
  } catch {
    return false;
  }
}
