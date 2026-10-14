import webpush from "web-push";
import { config } from "./config.js";
import { getSetting, json, setSetting, sql } from "./db.js";

/** Web Push (VAPID). Keys are generated on first start and stored in the DB. */

let ready: Promise<{ publicKey: string; privateKey: string }> | null = null;

export function vapidKeys() {
  if (!ready) {
    ready = (async () => {
      let keys = await getSetting<{ publicKey: string; privateKey: string }>("vapid");
      if (!keys) {
        keys = webpush.generateVAPIDKeys();
        await setSetting("vapid", keys);
      }
      webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
      return keys;
    })();
  }
  return ready;
}

export async function saveSubscription(sub: { endpoint: string; keys: Record<string, string> }, userAgent?: string) {
  await sql`insert into push_subscriptions (endpoint, keys, user_agent) values (${sub.endpoint}, ${json(sub.keys)}, ${userAgent ?? null})
    on conflict (endpoint) do update set keys = excluded.keys`;
}

export async function removeSubscription(endpoint: string) {
  await sql`delete from push_subscriptions where endpoint = ${endpoint}`;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  /** Kind of notification: "attention" (needs you) or "done". Users can mute "done". */
  kind?: "attention" | "done";
}

export async function notify(payload: PushPayload) {
  try {
    const prefs = (await getSetting<{ done?: boolean; attention?: boolean }>("notifications")) ?? {};
    if (payload.kind === "done" && prefs.done === false) return;
    if (payload.kind === "attention" && prefs.attention === false) return;
    await vapidKeys();
    const subs = await sql<{ endpoint: string; keys: { p256dh: string; auth: string } }[]>`select endpoint, keys from push_subscriptions`;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { TTL: 3600 });
        } catch (err: any) {
          if (err?.statusCode === 404 || err?.statusCode === 410) await removeSubscription(s.endpoint);
          else console.warn("[push] failed", err?.statusCode ?? err?.message);
        }
      }),
    );
  } catch (err) {
    console.warn("[push] error", (err as Error).message);
  }
}
