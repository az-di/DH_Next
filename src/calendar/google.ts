import { config } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import type { BusyBlock, CalendarConnection } from "../types.ts";

// Google Calendar via OAuth 2.0 with the free/busy-only scope. This scope can
// read busy intervals and nothing else: no titles, attendees, or locations.
export const FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

export const redirectUri = () => `${config.publicBaseUrl}/oauth/google/callback`;

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: FREEBUSY_SCOPE,
    access_type: "offline", // we need a refresh token for later lookups
    prompt: "consent", // force a refresh token even on re-connect
    include_granted_scopes: "false",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`google token request failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

export async function exchangeCode(code: string) {
  const tokens = await tokenRequest({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });
  if (!tokens.refresh_token) throw new Error("google did not return a refresh token");
  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
}

/** Returns a valid access token, refreshing (and persisting) it when it's about to expire. */
export async function getAccessToken(conn: CalendarConnection, repo: Repo): Promise<string> {
  const expiresAt = conn.accessTokenExpiresAt ? Date.parse(conn.accessTokenExpiresAt) : 0;
  if (conn.accessToken && expiresAt - Date.now() > 60_000) return conn.accessToken;

  const tokens = await tokenRequest({ refresh_token: conn.refreshToken, grant_type: "refresh_token" });
  const accessTokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  await repo.saveCalendarConnection({
    userId: conn.userId,
    provider: conn.provider,
    refreshToken: tokens.refresh_token ?? conn.refreshToken,
    accessToken: tokens.access_token,
    accessTokenExpiresAt,
  });
  return tokens.access_token;
}

/** Busy blocks on the user's primary calendar between timeMin and timeMax. */
export async function fetchBusy(accessToken: string, timeMin: Date, timeMax: Date): Promise<BusyBlock[]> {
  const res = await fetch(FREEBUSY_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: [{ id: "primary" }],
    }),
  });
  if (!res.ok) throw new Error(`google freeBusy failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as {
    calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
  };
  const primary = data.calendars.primary;
  if (primary?.errors?.length) throw new Error(`google freeBusy error: ${JSON.stringify(primary.errors)}`);
  return (primary?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}
