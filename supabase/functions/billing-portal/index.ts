// POST /functions/v1/billing-portal  (signed-in resident or family member who
// was given payment access, verify_jwt = true)
// Returns a Stripe customer portal link to update the card or bank account,
// see invoices and download receipts.
//
// Body: { resident_id }

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, env, json } from "../_shared/http.ts";
import { stripeRequest } from "../_shared/stripe.ts";

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
  const { data: can } = await asUser.rpc("portal_can", { p_resident: resident_id, p_what: "payments" });
  if (can !== true) return json({ error: "Not allowed" }, 403);

  const { data: res } = await admin.from("residents").select("inquiry_id, inquiries(stripe_customer_id)")
    .eq("id", resident_id).single();
  const customer = (res?.inquiries as { stripe_customer_id?: string } | null)?.stripe_customer_id;
  if (!customer) return json({ error: "No billing account yet" }, 404);

  const session = await stripeRequest<{ url: string }>(env("STRIPE_SECRET_KEY"), "POST", "billing_portal/sessions", {
    customer,
    return_url: `${env("APP_URL").replace(/\/$/, "")}/portal`,
  });
  return json({ url: session.url });
});
