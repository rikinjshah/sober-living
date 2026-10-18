// POST /functions/v1/oura-sync  (verify_jwt = false; called by a schedule)
// Requires header x-cron-secret: <CRON_SECRET>. Refreshes tokens and pulls the
// last few days for every connected ring. Safe to run as often as hourly.

import { createClient } from "npm:@supabase/supabase-js@2";
import { env, json } from "../_shared/http.ts";
import { OuraAuthError, pullDays, tokenRequest } from "../_shared/oura.ts";

const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

Deno.serve(async (req) => {
  const secret = env("CRON_SECRET");
  if (req.headers.get("x-cron-secret") !== secret) return json({ error: "Forbidden" }, 403);

  const { data: conns, error } = await admin.from("oura_connections").select("*");
  if (error) return json({ error: error.message }, 500);

  const results: Record<string, string> = {};
  for (const c of conns ?? []) {
    try {
      let token = c.access_token;
      if (new Date(c.token_expires_at).getTime() < Date.now() + 5 * 60e3) {
        const t = await tokenRequest(env("OURA_CLIENT_ID"), env("OURA_CLIENT_SECRET"), {
          grant_type: "refresh_token",
          refresh_token: c.refresh_token,
        }).catch((e) => {
          throw new OuraAuthError(String(e));
        });
        token = t.access_token;
        await admin.from("oura_connections").update({
          access_token: t.access_token,
          refresh_token: t.refresh_token,
          token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
        }).eq("resident_id", c.resident_id);
      }
      // Re-pull a few days back: Oura revises scores as the ring syncs late.
      const from = c.last_synced_at ? new Date(c.last_synced_at) : new Date();
      const start = new Date(Math.min(from.getTime(), Date.now()) - 3 * 864e5);
      const rows = await pullDays(token, c.resident_id, start, new Date(Date.now() + 864e5));
      if (rows.length) {
        const { error: upErr } = await admin.from("health_daily").upsert(rows);
        if (upErr) throw upErr;
      }
      await admin.from("oura_connections").update({ last_synced_at: new Date().toISOString(), last_error: null })
        .eq("resident_id", c.resident_id);
      results[c.resident_id] = `ok ${rows.length}`;
    } catch (e) {
      const reconnect = e instanceof OuraAuthError;
      await admin.from("oura_connections").update({
        last_error: reconnect ? "Resident needs to reconnect Oura" : String(e).slice(0, 500),
      }).eq("resident_id", c.resident_id);
      results[c.resident_id] = reconnect ? "needs reconnect" : "error";
      console.error(c.resident_id, e);
    }
  }
  return json({ synced: results });
});
