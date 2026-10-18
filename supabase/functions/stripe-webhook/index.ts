// POST /functions/v1/stripe-webhook  (verify_jwt = false; Stripe signature checked instead)
// Subscribe in Stripe to: checkout.session.completed, checkout.session.async_payment_succeeded,
// checkout.session.expired, invoice.paid, invoice.payment_failed, customer.subscription.deleted

import { createClient } from "npm:@supabase/supabase-js@2";
import { env, escapeHtml, sendEmail } from "../_shared/http.ts";
import { verifyStripeSignature } from "../_shared/stripe.ts";
import { planWebhook } from "../_shared/webhook.ts";

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("Webhook secret not configured", { status: 503 });
  const payload = await req.text();
  if (!(await verifyStripeSignature(payload, req.headers.get("Stripe-Signature"), secret))) {
    return new Response("Bad signature", { status: 400 });
  }
  const event = JSON.parse(payload);

  // Idempotency: Stripe retries; process each event once.
  const { error: seenErr } = await db.from("stripe_events").insert({ id: event.id, type: event.type });
  if (seenErr?.code === "23505") return new Response("duplicate", { status: 200 });

  try {
    const plan = planWebhook(event);

    let inquiryId = plan.inquiryId;
    if (!inquiryId && plan.subscriptionId) {
      const { data } = await db.from("inquiries").select("id").eq("stripe_subscription_id", plan.subscriptionId).maybeSingle();
      inquiryId = data?.id ?? null;
    }
    if (!inquiryId) return new Response("ignored", { status: 200 });

    const { data: inq } = await db.from("inquiries")
      .select("id, status, applicant_name, intake_fee_cents, houses(name, operator_email)")
      .eq("id", inquiryId).maybeSingle();
    if (!inq) return new Response("unknown inquiry", { status: 200 });

    // Re-plan with the inquiry's intake fee so invoice lines are classified correctly.
    const final = event.type === "invoice.paid" ? planWebhook(event, inq.intake_fee_cents) : plan;

    if (final.inquiryUpdate) {
      const update = { ...final.inquiryUpdate };
      // Never move an admitted resident backwards, and don't re-admit someone who left.
      if (update.status && ["admitted", "moved_out", "withdrawn", "declined"].includes(inq.status)) delete update.status;
      // Clean nulls Stripe didn't send.
      for (const k of Object.keys(update)) if (update[k] === null && k !== "stripe_checkout_url") delete update[k];
      if (Object.keys(update).length) await db.from("inquiries").update(update).eq("id", inquiryId);
    }
    for (const p of final.payments) {
      await db.from("payments").upsert({ ...p, inquiry_id: inquiryId, raw: event.data.object }, { onConflict: "stripe_object_id" });
    }
    if (final.log) {
      await db.from("inquiry_events").insert({ inquiry_id: inquiryId, kind: final.log.kind, actor: "stripe", detail: final.log.detail });
    }

    const house = (inq as any).houses;
    const operatorTo = house?.operator_email ?? Deno.env.get("OPERATOR_EMAIL");
    if (final.notifyOperator && operatorTo) {
      await sendEmail(operatorTo, `${final.notifyOperator}: ${inq.applicant_name}`,
        `<p>${escapeHtml(final.notifyOperator)} for <b>${escapeHtml(inq.applicant_name)}</b> at ${escapeHtml(house?.name ?? "")}.</p>
         <p>Stripe event: ${escapeHtml(event.type)}</p>`);
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error(e);
    // Let Stripe retry.
    await db.from("stripe_events").delete().eq("id", event.id);
    return new Response("error", { status: 500 });
  }
});
