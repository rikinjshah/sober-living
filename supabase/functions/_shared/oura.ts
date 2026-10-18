// Oura API v2: OAuth and turning API documents into one health_daily row per day.
// Docs: https://cloud.ouraring.com/v2/docs. Each resident authorizes their own
// ring. Oura requires an active Oura Membership on the ring for API access.

export const OURA_AUTHORIZE = "https://cloud.ouraring.com/oauth/authorize";
export const OURA_TOKEN = "https://api.ouraring.com/oauth/token";
export const OURA_API = "https://api.ouraring.com/v2/usercollection";
export const OURA_SCOPES = "daily heartrate";

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: OURA_SCOPES,
    state,
  });
  return `${OURA_AUTHORIZE}?${q}`;
}

export interface OuraTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

// grant: { grant_type: "authorization_code", code, redirect_uri } or
//        { grant_type: "refresh_token", refresh_token }
// Oura refresh tokens are single use, so always store the new one.
export async function tokenRequest(
  clientId: string,
  clientSecret: string,
  grant: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<OuraTokens> {
  const res = await fetchFn(OURA_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...grant, client_id: clientId, client_secret: clientSecret }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Oura token ${grant.grant_type} failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body as OuraTokens;
}

export async function fetchCollection(
  token: string,
  kind: "sleep" | "daily_sleep" | "daily_readiness" | "daily_activity",
  startDate: string,
  endDate: string,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let next: string | null = null;
  do {
    const q = new URLSearchParams({ start_date: startDate, end_date: endDate });
    if (next) q.set("next_token", next);
    const res = await fetchFn(`${OURA_API}/${kind}?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new OuraAuthError(`Oura ${kind}: 401`);
    if (!res.ok) throw new Error(`Oura ${kind}: ${res.status} ${await res.text()}`);
    const body = await res.json();
    out.push(...(body.data ?? []));
    next = body.next_token ?? null;
  } while (next);
  return out;
}

export class OuraAuthError extends Error {}

const min = (sec: unknown) => (typeof sec === "number" ? Math.round(sec / 60) : null);
const num = (v: unknown) => (typeof v === "number" ? Math.round(v) : null);

export interface HealthDay {
  resident_id: string;
  day: string;
  sleep_score: number | null;
  readiness_score: number | null;
  activity_score: number | null;
  total_sleep_min: number | null;
  deep_sleep_min: number | null;
  rem_sleep_min: number | null;
  light_sleep_min: number | null;
  awake_min: number | null;
  sleep_efficiency: number | null;
  sleep_latency_min: number | null;
  bedtime_start: string | null;
  bedtime_end: string | null;
  lowest_hr: number | null;
  avg_hrv: number | null;
  steps: number | null;
  synced_at: string;
}

// Merge the four Oura collections into one row per day. For sleep detail, use
// the night's main sleep: the longest "long_sleep" period, else the longest
// period of any type except deleted ones. Oura dates a sleep by the day you wake.
export function toHealthDays(
  residentId: string,
  docs: {
    sleep: Record<string, unknown>[];
    daily_sleep: Record<string, unknown>[];
    daily_readiness: Record<string, unknown>[];
    daily_activity: Record<string, unknown>[];
  },
  now = new Date(),
): HealthDay[] {
  const days = new Map<string, HealthDay>();
  const get = (day: string): HealthDay => {
    let d = days.get(day);
    if (!d) {
      d = {
        resident_id: residentId, day, sleep_score: null, readiness_score: null, activity_score: null,
        total_sleep_min: null, deep_sleep_min: null, rem_sleep_min: null, light_sleep_min: null,
        awake_min: null, sleep_efficiency: null, sleep_latency_min: null, bedtime_start: null,
        bedtime_end: null, lowest_hr: null, avg_hrv: null, steps: null, synced_at: now.toISOString(),
      };
      days.set(day, d);
    }
    return d;
  };

  for (const s of docs.daily_sleep) if (s.day) get(String(s.day)).sleep_score = num(s.score);
  for (const r of docs.daily_readiness) if (r.day) get(String(r.day)).readiness_score = num(r.score);
  for (const a of docs.daily_activity) {
    if (!a.day) continue;
    const d = get(String(a.day));
    d.activity_score = num(a.score);
    d.steps = num(a.steps);
  }

  const best = new Map<string, Record<string, unknown>>();
  const rank = (p: Record<string, unknown>) =>
    (p.type === "long_sleep" ? 1e9 : 0) + (typeof p.total_sleep_duration === "number" ? p.total_sleep_duration : 0);
  for (const p of docs.sleep) {
    if (!p.day || p.type === "deleted") continue;
    const cur = best.get(String(p.day));
    if (!cur || rank(p) > rank(cur)) best.set(String(p.day), p);
  }
  for (const [day, p] of best) {
    const d = get(day);
    d.total_sleep_min = min(p.total_sleep_duration);
    d.deep_sleep_min = min(p.deep_sleep_duration);
    d.rem_sleep_min = min(p.rem_sleep_duration);
    d.light_sleep_min = min(p.light_sleep_duration);
    d.awake_min = min(p.awake_time);
    d.sleep_efficiency = num(p.efficiency);
    d.sleep_latency_min = min(p.latency);
    d.bedtime_start = (p.bedtime_start as string) ?? null;
    d.bedtime_end = (p.bedtime_end as string) ?? null;
    d.lowest_hr = num(p.lowest_heart_rate);
    d.avg_hrv = num(p.average_hrv);
  }

  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Pull a date range for one connection and return the rows to upsert.
export async function pullDays(
  token: string,
  residentId: string,
  start: Date,
  end: Date,
  fetchFn: typeof fetch = fetch,
): Promise<HealthDay[]> {
  const s = isoDate(start), e = isoDate(end);
  const [sleep, daily_sleep, daily_readiness, daily_activity] = await Promise.all([
    fetchCollection(token, "sleep", s, e, fetchFn),
    fetchCollection(token, "daily_sleep", s, e, fetchFn),
    fetchCollection(token, "daily_readiness", s, e, fetchFn),
    fetchCollection(token, "daily_activity", s, e, fetchFn),
  ]);
  return toHealthDays(residentId, { sleep, daily_sleep, daily_readiness, daily_activity });
}
