import { anthropicProvider } from "./anthropic.js";
import { demoProvider } from "./demo.js";
import { openaiCompatProvider, xaiProvider } from "./openai.js";
import type { ModelInfo, Provider } from "./types.js";

export const providers: Provider[] = [anthropicProvider, xaiProvider, openaiCompatProvider, demoProvider];

export function getProvider(id: string): Provider {
  const p = providers.find((p) => p.id === id);
  if (!p) throw new Error(`Unknown provider "${id}"`);
  if (!p.configured()) throw new Error(`Provider "${id}" is not configured – add its API key to .env`);
  return p;
}

/** The best default for new bots: the first configured real provider, otherwise demo. */
export function defaultModel(): { provider: string; model: string } {
  const p = providers.find((p) => p.id !== "demo" && p.configured() && p.defaultModel()) ?? demoProvider;
  return { provider: p.id, model: p.defaultModel() };
}

let cache: { at: number; data: { providers: { id: string; label: string; configured: boolean; error?: string }[]; models: ModelInfo[] } } | null = null;

export async function listAllModels(force = false) {
  if (cache && !force && Date.now() - cache.at < 10 * 60_000) return cache.data;
  const out: { providers: { id: string; label: string; configured: boolean; error?: string }[]; models: ModelInfo[] } = {
    providers: [],
    models: [],
  };
  await Promise.all(
    providers.map(async (p) => {
      const entry: { id: string; label: string; configured: boolean; error?: string } = { id: p.id, label: p.label, configured: p.configured() };
      out.providers.push(entry);
      if (!entry.configured) return;
      try {
        out.models.push(...(await p.listModels()));
      } catch (err) {
        entry.error = String((err as Error).message ?? err);
        // Fall back to the configured default so the picker is never empty.
        if (p.defaultModel()) out.models.push({ provider: p.id, id: p.defaultModel(), label: p.defaultModel() });
      }
    }),
  );
  const order = providers.map((p) => p.id);
  out.providers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  out.models.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
  cache = { at: Date.now(), data: out };
  return out;
}
