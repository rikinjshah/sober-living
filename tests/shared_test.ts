// Run: deno test tests/
import { assert, assertEquals } from "jsr:@std/assert@1";
import { validateIntake } from "../supabase/functions/_shared/intake.ts";
import { checkoutParams, formEncode, hmacHex, verifyStripeSignature } from "../supabase/functions/_shared/stripe.ts";
import { planWebhook } from "../supabase/functions/_shared/webhook.ts";

const TODAY = "2026-10-07";
const base = {
  submitted_by: "family", contact_name: "Ann Lee", contact_email: "ANN@example.com",
  contact_relationship: "Mother", applicant_name: "Sam Lee", applicant_age: "29",
  current_setting: "residential_treatment", treatment_program: "Example Rehab",
  expected_discharge: "2026-10-20", sobriety_date: "2026-09-01", desired_move_in: "2026-10-20",
  preferred_room: "private", heard_about_us: "treatment_program",
  consent_contact: true, consent_privacy: true,
};

Deno.test("valid family inquiry normalizes and flags a professional referral", () => {
  const r = validateIntake(base, TODAY);
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.record.contact_email, "ann@example.com");
  assertEquals(r.record.applicant_age, 29);
  assertEquals(r.record.screening_flags, ["no_direct_applicant_contact", "professional_referral"]);
});

Deno.test("missing consent and bad email are rejected", () => {
  const r = validateIntake({ ...base, contact_email: "nope", consent_privacy: false }, TODAY);
  assert(!r.ok);
  if (r.ok) return;
  assertEquals(Object.keys(r.errors).sort(), ["consent_privacy", "contact_email"]);
});

Deno.test("self applicant becomes the applicant; risk flags raised, never declined", () => {
  const r = validateIntake({
    submitted_by: "self", contact_name: "Jo Park", contact_email: "jo@example.com",
    applicant_age: 17, needs_medical_detox: "on", current_setting: "detox",
    sobriety_date: "2026-10-01", desired_move_in: "2026-10-08",
    consent_contact: "on", consent_privacy: "on",
  }, TODAY);
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.record.applicant_name, "Jo Park");
  assertEquals(r.record.applicant_email, "jo@example.com");
  assertEquals(r.record.screening_flags.sort(), [
    "currently_in_detox", "needs_detox_first", "sobriety_under_14_days", "under_18", "urgent_move_in",
  ]);
});

Deno.test("future sobriety date rejected; garbage enums dropped", () => {
  const r = validateIntake({ ...base, sobriety_date: "2027-01-01" }, TODAY);
  assert(!r.ok);
  const r2 = validateIntake({ ...base, preferred_room: "penthouse", current_setting: "x" }, TODAY);
  assert(r2.ok);
  if (r2.ok) {
    assertEquals(r2.record.preferred_room, null);
    assertEquals(r2.record.current_setting, null);
  }
});

Deno.test("checkout params: weekly rent plus one-time intake fee, card and ACH", () => {
  const p = checkoutParams({
    inquiryId: "inq1", customerId: "cus_1", houseName: "Petaluma House", bedLabel: "Room 1",
    roomType: "private", dailyRateCents: 30000, billingDays: 7, intakeFeeCents: 50000,
    successUrl: "https://x/welcome.html", cancelUrl: "https://x/apply.html",
  });
  const enc = formEncode(p).map(decodeURIComponent);
  assert(enc.includes("mode=subscription"));
  assert(enc.includes("line_items[0][price_data][unit_amount]=210000"));
  assert(enc.includes("line_items[0][price_data][recurring][interval]=week"));
  assert(enc.includes("line_items[1][price_data][unit_amount]=50000"));
  assert(!enc.some((s) => s.startsWith("line_items[1][price_data][recurring]")));
  assert(enc.includes("payment_method_types[1]=us_bank_account"));
  assert(enc.includes("subscription_data[metadata][inquiry_id]=inq1"));
});

Deno.test("stripe signature: valid, tampered, stale", async () => {
  const secret = "whsec_test", payload = '{"id":"evt_1"}', t = 1_800_000_000;
  const sig = await hmacHex(secret, `${t}.${payload}`);
  assert(await verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret, 300, t + 10));
  assert(!(await verifyStripeSignature(payload + " ", `t=${t},v1=${sig}`, secret, 300, t + 10)));
  assert(!(await verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret, 300, t + 1000)));
  assert(!(await verifyStripeSignature(payload, null, secret)));
});

Deno.test("webhook: card checkout admits; ACH checkout waits for invoice", () => {
  const card = planWebhook({ type: "checkout.session.completed", data: { object: {
    id: "cs_1", payment_status: "paid", subscription: "sub_1", customer: "cus_1", metadata: { inquiry_id: "inq1" },
  } } });
  assertEquals(card.inquiryId, "inq1");
  assertEquals(card.inquiryUpdate?.status, "admitted");
  const ach = planWebhook({ type: "checkout.session.completed", data: { object: {
    id: "cs_2", payment_status: "unpaid", subscription: "sub_2", metadata: { inquiry_id: "inq2" },
  } } });
  assertEquals(ach.inquiryUpdate?.status, undefined);
  assertEquals(ach.inquiryUpdate?.stripe_subscription_id, "sub_2");
});

Deno.test("webhook: first invoice splits rent and intake fee, admits", () => {
  const plan = planWebhook({ type: "invoice.paid", data: { object: {
    id: "in_1", currency: "usd", billing_reason: "subscription_create", amount_paid: 260000, created: 1_800_000_000,
    parent: { subscription_details: { subscription: "sub_1", metadata: { inquiry_id: "inq1" } } },
    lines: { data: [
      { amount: 210000, parent: { type: "subscription_item_details" }, period: { start: 1_800_000_000, end: 1_800_604_800 } },
      { amount: 50000, parent: { type: "invoice_item_details" } },
    ] },
  } } }, 50000);
  assertEquals(plan.inquiryId, "inq1");
  assertEquals(plan.inquiryUpdate, { status: "admitted" });
  assertEquals(plan.payments.map((p) => [p.kind, p.amount_cents]), [["rent", 210000], ["intake_fee", 50000]]);
});

Deno.test("webhook: renewal invoice records rent only; failure notifies", () => {
  const renew = planWebhook({ type: "invoice.paid", data: { object: {
    id: "in_2", billing_reason: "subscription_cycle", subscription: "sub_1",
    lines: { data: [{ amount: 210000, type: "subscription", period: { start: 1, end: 2 } }] },
  } } }, 50000);
  assertEquals(renew.inquiryUpdate, null);
  assertEquals(renew.subscriptionId, "sub_1");
  assertEquals(renew.payments.length, 1);
  const failed = planWebhook({ type: "invoice.payment_failed", data: { object: {
    id: "in_3", amount_due: 210000, attempt_count: 2, subscription: "sub_1",
  } } });
  assertEquals(failed.notifyOperator, "Payment failed");
  assertEquals(failed.payments[0].status, "failed");
});
