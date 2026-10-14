function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name}`);
  }
  return v;
}

function bool(name: string, fallback: boolean) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export const config = {
  port: Number(env("PORT", "4000")),
  databaseUrl: env("DATABASE_URL", "postgres://crew:crew@localhost:5432/crew"),
  redisUrl: env("REDIS_URL", "redis://localhost:6379"),
  dataDir: env("DATA_DIR", "/data"),
  publicUrl: env("PUBLIC_URL", "http://localhost:8080"),
  timezone: env("TZ", "Europe/Stockholm"),
  sessionDays: Number(env("SESSION_DAYS", "30")),
  adminUsername: env("ADMIN_USERNAME", "admin"),
  adminPassword: process.env.ADMIN_PASSWORD ?? "",
  workstation: {
    url: env("WORKSTATION_URL", "http://workstation:7000"),
    token: env("WORKSTATION_TOKEN", ""),
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    baseUrl: process.env.ANTHROPIC_BASE_URL_OVERRIDE || undefined,
    defaultModel: env("ANTHROPIC_DEFAULT_MODEL", "claude-opus-5-5"),
    refusalFallback: bool("ANTHROPIC_REFUSAL_FALLBACK", true),
  },
  xai: {
    apiKey: process.env.XAI_API_KEY ?? "",
    baseUrl: env("XAI_BASE_URL", "https://api.x.ai/v1"),
    defaultModel: env("XAI_DEFAULT_MODEL", "grok-4"),
  },
  openaiCompat: {
    // Any other OpenAI-compatible endpoint (Ollama, OpenRouter, LM Studio, vLLM …)
    apiKey: process.env.OPENAI_COMPAT_API_KEY ?? "",
    baseUrl: process.env.OPENAI_COMPAT_BASE_URL ?? "",
    label: env("OPENAI_COMPAT_LABEL", "Custom"),
    defaultModel: process.env.OPENAI_COMPAT_DEFAULT_MODEL ?? "",
  },
  autoReviewModel: process.env.AUTO_REVIEW_MODEL ?? "", // e.g. "anthropic:claude-haiku-5-5"
  searxngUrl: process.env.SEARXNG_URL ?? "",
  braveApiKey: process.env.BRAVE_API_KEY ?? "",
  maxStepsPerRun: Number(env("MAX_STEPS_PER_RUN", "60")),
  workerConcurrency: Number(env("WORKER_CONCURRENCY", "4")),
  maxBotChainDepth: Number(env("MAX_BOT_CHAIN_DEPTH", "5")),
  vapidSubject: env("VAPID_SUBJECT", "mailto:admin@localhost"),
  secureCookies: bool("SECURE_COOKIES", env("PUBLIC_URL", "http://localhost:8080").startsWith("https://")),
};

/** Values that must never show up in logs, events or tool output. */
export function secretValues(): string[] {
  return [
    config.anthropic.apiKey,
    config.xai.apiKey,
    config.openaiCompat.apiKey,
    config.workstation.token,
    config.adminPassword,
    config.braveApiKey,
    process.env.POSTGRES_PASSWORD ?? "",
  ].filter((v) => v && v.length >= 6);
}
