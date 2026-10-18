// GET /functions/v1/oura-callback  (verify_jwt = false; Oura redirects here)
// Exchanges the code for tokens, stores them, pulls the last 30 days and sends
// the resident back to the portal.

import { createClient } from "npm:@supabase/supabase-js@2";
import { env } from "../_shared/http.ts";
import { pullDays, tokenRequest } from "../_shared/oura.ts";

const SUPABASE_URL = env("SUPABASE_URL");
const admin = createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const back = (result: string) =>
  Response.redirect(`${env("APP_URL").replace(/\/$/, "")}/portal?oura=${result}`, 302);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  if (!state) return back("error");

  const { data: st } = await admin.from("oura_oauth_states").delete().eq("state", state).select().maybeSingle();
  if (!st || Date.now() - new Date(st.created_at).getTime() > 3600e3) return back("expired");
  if (!code) return back("cancelled");

  try {
    const tok = await tokenRequest(env("OURA_CLIENT_ID"), env("OURA_CLIENT_SECRET"), {
      grant_type: "authorization_code",
      code,
      redirect_uri: `${SUPABASE_URL}/functions/v1/oura-callback`,
    });
    const now = new Date();
    const { error } = await admin.from("oura_connections").upsert({
      resident_id: st.resident_id,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      token_expires_at: new Date(now.getTime() + tok.expires_in * 1000).toISOString(),
      scopes: tok.scope ?? null,
      connected_at: now.toISOString(),
      last_error: null,
    });
    if (error) throw error;

    const rows = await pullDays(tok.access_token, st.resident_id, new Date(now.getTime() - 30 * 864e5),
      new Date(now.getTime() + 864e5));
    if (rows.length) await admin.from("health_daily").upsert(rows);
    await admin.from("oura_connections").update({ last_synced_at: now.toISOString() }).eq("resident_id", st.resident_id);
    await admin.from("portal_access_log").insert({
      viewer_role: "self", resident_id: st.resident_id, action: "oura_connected", detail: { days: rows.length },
    });
    return back("connected");
  } catch (e) {
    console.error(e);
    return back("error");
  }
});
