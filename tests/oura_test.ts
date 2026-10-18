// Run: deno test tests/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { authorizeUrl, fetchCollection, OuraAuthError, toHealthDays } from "../supabase/functions/_shared/oura.ts";

Deno.test("authorize URL carries client, redirect, scopes and state", () => {
  const u = new URL(authorizeUrl("cid", "https://x.supabase.co/functions/v1/oura-callback", "st"));
  assertEquals(u.origin + u.pathname, "https://cloud.ouraring.com/oauth/authorize");
  assertEquals(u.searchParams.get("client_id"), "cid");
  assertEquals(u.searchParams.get("response_type"), "code");
  assertEquals(u.searchParams.get("scope"), "daily heartrate");
  assertEquals(u.searchParams.get("state"), "st");
});

Deno.test("merges collections into one row per day and picks the main sleep", () => {
  const rows = toHealthDays("r1", {
    sleep: [
      { day: "2026-10-06", type: "late_nap", total_sleep_duration: 1800 },
      { day: "2026-10-06", type: "long_sleep", total_sleep_duration: 25860, deep_sleep_duration: 4800,
        rem_sleep_duration: 6000, light_sleep_duration: 15060, awake_time: 2400, efficiency: 91, latency: 600,
        bedtime_start: "2026-10-05T22:51:00-07:00", bedtime_end: "2026-10-06T06:41:00-07:00",
        lowest_heart_rate: 52, average_hrv: 48.6 },
      { day: "2026-10-07", type: "deleted", total_sleep_duration: 99999 },
    ],
    daily_sleep: [{ day: "2026-10-06", score: 84 }, { day: "2026-10-07", score: 70 }],
    daily_readiness: [{ day: "2026-10-06", score: 79 }],
    daily_activity: [{ day: "2026-10-06", score: 88, steps: 9120 }],
  }, new Date("2026-10-07T12:00:00Z"));
  assertEquals(rows.length, 2);
  const d = rows[0];
  assertEquals(d.day, "2026-10-06");
  assertEquals([d.sleep_score, d.readiness_score, d.activity_score, d.steps], [84, 79, 88, 9120]);
  assertEquals([d.total_sleep_min, d.deep_sleep_min, d.rem_sleep_min, d.awake_min], [431, 80, 100, 40]);
  assertEquals([d.lowest_hr, d.avg_hrv, d.sleep_efficiency], [52, 49, 91]);
  assertEquals(rows[1].total_sleep_min, null); // deleted period ignored
  assertEquals(rows[1].sleep_score, 70);
});

Deno.test("follows next_token pages and maps 401 to a reconnect error", async () => {
  const calls: string[] = [];
  const fake = (async (url: string) => {
    calls.push(url);
    const page2 = new URL(url).searchParams.get("next_token") === "p2";
    return new Response(JSON.stringify({ data: [{ day: page2 ? "b" : "a" }], next_token: page2 ? null : "p2" }));
  }) as unknown as typeof fetch;
  const docs = await fetchCollection("t", "daily_sleep", "2026-10-01", "2026-10-07", fake);
  assertEquals(docs.map((d) => d.day), ["a", "b"]);
  assertEquals(calls.length, 2);

  const unauthorized = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  let threw = false;
  try {
    await fetchCollection("t", "sleep", "2026-10-01", "2026-10-07", unauthorized);
  } catch (e) {
    threw = e instanceof OuraAuthError;
  }
  assert(threw);
});
