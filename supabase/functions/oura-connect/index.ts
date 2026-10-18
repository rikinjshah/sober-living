// POST /functions/v1/oura-connect  (signed-in resident, verify_jwt = true)
// Starts Oura authorization for the caller's own ring and returns the Oura URL.
//
// Body: { resident_id }

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, env, json } from "../_shared/http.ts";
import { authorizeUrl } from "../_shared/oura.ts";

const SUPABASE_URL = env("SUPABASE_URL");
const admin = createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const { resident_id } = await req.json().catch(() => ({}));
  if (!resident_id) return json({ error: "resident_id is required" }, 400);

  const asUser = createClient(SUPABASE_URL, env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: role } = await asUser.rpc("portal_role", { p_resident: resident_id });
  if (role !== "self") return json({ error: "Only the resident can connect their own ring" }, 403);

  const clientId = Deno.env.get("OURA_CLIENT_ID");
  if (!clientId) return json({ error: "Oura isn't set up yet. Ask the house to finish setup." }, 503);

  const state = crypto.randomUUID() + crypto.randomUUID().replaceAll("-", "");
  await admin.from("oura_oauth_states").delete().lt("created_at", new Date(Date.now() - 3600e3).toISOString());
  const { error } = await admin.from("oura_oauth_states").insert({ state, resident_id });
  if (error) return json({ error: error.message }, 500);

  return json({ url: authorizeUrl(clientId, `${SUPABASE_URL}/functions/v1/oura-callback`, state) });
});
