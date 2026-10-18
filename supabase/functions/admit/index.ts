// POST /functions/v1/admit  (operator only, verify_jwt = true)
// Approves an inquiry: assigns a bed and rate, creates the Stripe customer and
// a checkout link (intake fee + rent autopay), and emails the link.
//
// Body: { inquiry_id, bed_id, daily_rate_cents?, intake_fee_cents?, move_in_date?, send_email? }

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, env, escapeHtml, json, sendEmail } from "../_shared/http.ts";
import { checkoutParams, stripeRequest } from "../_shared/stripe.ts";

const SUPABASE_URL = env("SUPABASE_URL");
const admin = createClient(SUPABASE_URL, env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Act as the signed-in user to confirm they are an operator.
  const asUser = createClient(SUPABASE_URL, env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: isOp } = await asUser.rpc("is_operator");
  if (isOp !== true) return json({ error: "Operators only" }, 403);
  const { data: { user } } = await asUser.auth.getUser();

  const body = await req.json().catch(() => ({}));
  const { inquiry_id, bed_id } = body as Record<string, string>;
  if (!inquiry_id || !bed_id) return json({ error: "inquiry_id and bed_id are required" }, 400);

  const { data: inq } = await admin.from("inquiries").select("*").eq("id", inquiry_id).single();
  if (!inq) return json({ error: "Inquiry not found" }, 404);
  if (["admitted", "declined", "withdrawn", "moved_out"].includes(inq.status)) {
    return json({ error: `Inquiry is ${inq.status}` }, 409);
  }

  const { data: bed } = await admin.from("beds").select("*, houses(*)").eq("id", bed_id).single();
  if (!bed || !bed.active || bed.house_id !== inq.house_id) return json({ error: "Bed not available" }, 400);
  const house = bed.houses;

  const dailyRate = Number(body.daily_rate_cents ?? bed.daily_rate_cents);
  const intakeFee = Number(body.intake_fee_cents ?? house.intake_fee_cents);
  if (!Number.isInteger(dailyRate) || dailyRate <= 0) return json({ error: "Invalid daily rate" }, 400);
  if (!Number.isInteger(intakeFee) || intakeFee < 0) return json({ error: "Invalid intake fee" }, 400);

  // Reserve the bed first; the partial unique index rejects double-booking.
  const { error: reserveErr } = await admin.from("inquiries").update({
    status: "approved",
    bed_id,
    daily_rate_cents: dailyRate,
    intake_fee_cents: intakeFee,
    move_in_date: body.move_in_date ?? inq.desired_move_in,
  }).eq("id", inquiry_id);
  if (reserveErr) {
    const taken = reserveErr.code === "23505";
    return json({ error: taken ? "That bed is already taken" : reserveErr.message }, taken ? 409 : 500);
  }

  const stripeKey = env("STRIPE_SECRET_KEY");
  const appUrl = env("APP_URL");
  const payer = { name: inq.contact_name, email: inq.contact_email };

  try {
    let customerId = inq.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripeRequest<{ id: string }>(stripeKey, "POST", "customers", {
        name: payer.name,
        email: payer.email,
        phone: inq.contact_phone ?? undefined,
        description: `Resident: ${inq.applicant_name}`,
        metadata: { inquiry_id, applicant_name: inq.applicant_name },
      }, `customer-${inquiry_id}`);
      customerId = customer.id;
    }

    const session = await stripeRequest<{ id: string; url: string }>(stripeKey, "POST", "checkout/sessions",
      checkoutParams({
        inquiryId: inquiry_id,
        customerId,
        houseName: house.name,
        bedLabel: bed.label,
        roomType: bed.room_type,
        dailyRateCents: dailyRate,
        billingDays: house.billing_days,
        intakeFeeCents: intakeFee,
        successUrl: `${appUrl}/welcome.html`,
        cancelUrl: `${appUrl}/apply.html`,
      }),
      `checkout-${inquiry_id}-${bed_id}-${dailyRate}-${intakeFee}`,
    );

    await admin.from("inquiries").update({
      status: "payment_sent",
      stripe_customer_id: customerId,
      stripe_checkout_id: session.id,
      stripe_checkout_url: session.url,
    }).eq("id", inquiry_id);

    await admin.from("inquiry_events").insert({
      inquiry_id, kind: "payment_link_created", actor: user?.email ?? "operator",
      detail: { bed: bed.label, daily_rate_cents: dailyRate, intake_fee_cents: intakeFee, session: session.id },
    });

    if (body.send_email !== false) {
      const first = payer.name.split(" ")[0];
      const period = house.billing_days === 30 ? "month" : house.billing_days === 7 ? "week" : `${house.billing_days} days`;
      await sendEmail(payer.email, `Your place at ${house.name}`, `
        <p>Hi ${escapeHtml(first)},</p>
        <p>We'd love to welcome ${escapeHtml(inq.applicant_name)} to ${escapeHtml(house.name)}.
        We're holding ${escapeHtml(bed.label)} (${bed.room_type} room).</p>
        <p>The rate is $${(dailyRate / 100).toFixed(0)} a day, billed every ${period} in advance by card or bank account,
        plus a one-time $${(intakeFee / 100).toFixed(0)} intake fee.</p>
        <p><a href="${session.url}">Complete payment and set up autopay</a></p>
        <p>The link holds the bed for 24 hours. Reply with any questions.</p>`);
    }

    return json({ ok: true, checkout_url: session.url });
  } catch (e) {
    console.error(e);
    // Leave it approved with the bed held so the operator can retry.
    await admin.from("inquiry_events").insert({
      inquiry_id, kind: "payment_link_failed", actor: "system", detail: { error: String(e) },
    });
    return json({ error: "Stripe error: " + (e as Error).message }, 502);
  }
});
