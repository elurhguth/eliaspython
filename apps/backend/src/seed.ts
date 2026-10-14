import { sql } from "./db.js";
import { defaultModel } from "./agent/providers/index.js";

/** A starter crew on first boot – a chief of staff plus two specialists. Fully editable. */
export async function seedBots() {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from bots`;
  if (n > 0) return;
  const { provider, model } = defaultModel();
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
