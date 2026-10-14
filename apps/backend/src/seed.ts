import { sql } from "./db.js";
import { defaultModel, getProvider } from "./agent/providers/index.js";

/**
 * Pick the default model, preferring one the provider actually lists (so a stale
 * default like an old Grok id doesn't break a fresh install).
 */
async function bestDefault() {
  const d = defaultModel();
  if (d.provider === "demo") return d;
  try {
    const models = await getProvider(d.provider).listModels();
    if (!models.length || models.some((m) => m.id === d.model)) return d;
    const preferred = models.find((m) => /grok|claude|gpt|llama|qwen/i.test(m.id)) ?? models[0];
    return { provider: d.provider, model: preferred.id };
  } catch {
    return d;
  }
}

/** Typical first run: start in demo mode, add an API key later. Move untouched demo bots over. */
async function upgradeDemoBots() {
  const [{ total, demo }] = await sql<{ total: number; demo: number }[]>`
    select count(*)::int as total, count(*) filter (where provider = 'demo')::int as demo from bots`;
  if (total === 0 || demo !== total) return;
  const { provider, model } = await bestDefault();
  if (provider === "demo") return;
  await sql`update bots set provider = ${provider}, model = ${model}, updated_at = now() where provider = 'demo'`;
  console.log(`[seed] API key found – moved ${demo} demo bot(s) to ${provider}/${model}`);
}

/** A starter crew on first boot – a chief of staff plus two specialists. Fully editable. */
export async function seedBots() {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from bots`;
  if (n > 0) return upgradeDemoBots();
  const { provider, model } = await bestDefault();
  const bots = [
    {
      name: "Vera",
      slug: "vera",
      role: "Chief of staff",
      avatar: "🧭",
      color: "#e8a25c",
      is_lead: true,
      instructions:
        "Du är teamledare. Ta emot uppdrag, bryt ned dem, gör enkla saker själv och lämna över specialistjobb till rätt kollega med delegate. Håll användaren kort uppdaterad och sammanfatta när allt är klart.",
    },
    {
      name: "Nils",
      slug: "nils",
      role: "Research & analys",
      avatar: "🔎",
      color: "#7cb7a6",
      is_lead: false,
      instructions:
        "Du gör grundlig research på webben: jämför källor, ange länkar och sammanfatta tydligt. Spara längre rapporter som Markdown-filer i ~/rapporter.",
    },
    {
      name: "Siri",
      slug: "siri",
      role: "Inkorg, kalender & utskick",
      avatar: "✉️",
      color: "#a99be0",
      is_lead: false,
      instructions:
        "Du sköter mejl, kalender och utskick via webbläsaren. Skriv alltid utkast först. Skicka aldrig något utan att användaren godkänt det. Lär dig användarens ton och spara den i delat minne.",
    },
  ];
  for (const [i, b] of bots.entries()) {
    await sql`insert into bots (name, slug, role, avatar, color, is_lead, instructions, provider, model, sort)
      values (${b.name}, ${b.slug}, ${b.role}, ${b.avatar}, ${b.color}, ${b.is_lead}, ${b.instructions}, ${provider}, ${model}, ${i})`;
  }
  console.log(`[seed] created starter crew using ${provider}/${model}`);
}
