// Central place for environment configuration. Every integration degrades to a
// local fallback when its keys are missing, so the app boots with no .env at all.

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

export const config = {
  port: Number(env("PORT", "3000")),
  publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:3000"),
  botName: env("BOT_NAME", "planner").toLowerCase(),
  defaultTimezone: env("DEFAULT_TIMEZONE", "America/Los_Angeles"),
  schedulerIntervalMs: Number(env("SCHEDULER_INTERVAL_MS", "60000")),

  /** "photon" | "sendblue" | "console" | "mock". Defaults to whichever has credentials. */
  messagingProvider: env("MESSAGING_PROVIDER"),

  // Photon Spectrum. Names match what spectrum-ts reads from the environment.
  photon: {
    projectId: env("SPECTRUM_PROJECT_ID"),
    projectSecret: env("SPECTRUM_PROJECT_SECRET"),
    webhookSecret: env("SPECTRUM_WEBHOOK_SECRET"),
    /** "stream" (long-lived connection, no public URL) or "webhook". */
    inbound: env("PHOTON_INBOUND", "stream") as "stream" | "webhook",
  },

  sendblue: {
    apiKey: env("SENDBLUE_API_KEY"),
    apiSecret: env("SENDBLUE_API_SECRET"),
    fromNumber: env("SENDBLUE_FROM_NUMBER"),
    webhookSecret: env("SENDBLUE_WEBHOOK_SECRET"),
  },

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

export const hasPhoton = () => Boolean(config.photon.projectId && config.photon.projectSecret);
export const hasSendblue = () => Boolean(config.sendblue.apiKey && config.sendblue.apiSecret);
export const hasSupabase = () => Boolean(config.supabase.url && config.supabase.serviceRoleKey);
export const hasGoogle = () => Boolean(config.google.clientId && config.google.clientSecret);
export const hasAnthropic = () => Boolean(config.anthropic.apiKey);
