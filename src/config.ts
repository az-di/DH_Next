// Central place for environment configuration. Every integration degrades to a
// local fallback when its keys are missing, so the app boots with no .env at all.

export function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export const config = {
  port: Number(env("PORT", "3000")),
  publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:3000"),
  botName: env("BOT_NAME", "planner").toLowerCase(),
  defaultTimezone: env("DEFAULT_TIMEZONE", "America/Los_Angeles"),
  schedulerIntervalMs: Number(env("SCHEDULER_INTERVAL_MS", "60000")),

  /** Provider names to run (see messaging/registry.ts). Empty = every provider with credentials. */
  messagingProviders: (env("MESSAGING_PROVIDERS") || env("MESSAGING_PROVIDER"))
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),

  supabase: {
    url: env("SUPABASE_URL"),
    serviceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY"),
  },

  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
  },

  /** Signs the per-user "connect your calendar" links. Set a stable value in production. */
  linkSecret: env("LINK_SECRET", "dev-only-link-secret"),

  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY"),
  },
};

export const hasSupabase = () => Boolean(config.supabase.url && config.supabase.serviceRoleKey);
export const hasGoogle = () => Boolean(config.google.clientId && config.google.clientSecret);
export const hasAnthropic = () => Boolean(config.anthropic.apiKey);
