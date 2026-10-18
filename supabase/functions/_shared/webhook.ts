// Turns a Stripe event into the database changes it implies. Pure, so the
// webhook function stays a thin shell and this logic is unit-tested.

export interface WebhookPlan {
  inquiryId: string | null;
  subscriptionId: string | null;            // used to find the inquiry when metadata is missing
  inquiryUpdate: Record<string, unknown> | null;
  payments: Record<string, unknown>[];
  log: { kind: string; detail: Record<string, unknown> } | null;
  notifyOperator: string | null;            // subject line, when the operator should hear about it
}

type Obj = Record<string, any>;

export function planWebhook(event: Obj, intakeFeeCents: number | null = null): WebhookPlan {
  const o: Obj = event?.data?.object ?? {};
  const empty: WebhookPlan = {
    inquiryId: null, subscriptionId: null, inquiryUpdate: null, payments: [], log: null, notifyOperator: null,
  };

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const inquiryId = o.metadata?.inquiry_id ?? o.client_reference_id ?? null;
      // ACH checkouts complete before the money clears; wait for the invoice.
      const paid = o.payment_status === "paid";
      return {
        ...empty,
        inquiryId,
        subscriptionId: o.subscription ?? null,
        inquiryUpdate: {
          stripe_subscription_id: o.subscription ?? null,
          stripe_customer_id: o.customer ?? null,
          ...(paid ? { status: "admitted" } : {}),
        },
        log: { kind: paid ? "checkout_paid" : "checkout_completed_pending", detail: { session: o.id, payment_status: o.payment_status } },
        notifyOperator: paid ? "Payment received: new resident admitted" : null,
      };
    }

    case "invoice.paid": {
      const inquiryId = o.subscription_details?.metadata?.inquiry_id
        ?? o.parent?.subscription_details?.metadata?.inquiry_id ?? null;
      const subscriptionId = o.subscription ?? o.parent?.subscription_details?.subscription ?? null;
      const lines: Obj[] = o.lines?.data ?? [];
      const payments: Record<string, unknown>[] = [];
      let rent = 0, fee = 0, other = 0;
      let periodStart: number | null = null, periodEnd: number | null = null;
      for (const l of lines) {
        // Subscription lines are rent; one-time checkout items arrive as invoice items.
        // Covers both the older (`type`) and newer (`parent.type`) Stripe API shapes.
        const recurring = l.type === "subscription"
          || l.parent?.type === "subscription_item_details"
          || !!l.price?.recurring;
        if (recurring) {
          rent += l.amount ?? 0;
          periodStart = l.period?.start ?? periodStart;
          periodEnd = l.period?.end ?? periodEnd;
        } else if (intakeFeeCents !== null && l.amount === intakeFeeCents) {
          fee += l.amount;
        } else {
          other += l.amount ?? 0;
        }
      }
      const iso = (s: number | null) => (s ? new Date(s * 1000).toISOString() : null);
      if (rent) payments.push({ stripe_object_id: `${o.id}:rent`, kind: "rent", amount_cents: rent, period_start: iso(periodStart), period_end: iso(periodEnd) });
      if (fee) payments.push({ stripe_object_id: `${o.id}:intake_fee`, kind: "intake_fee", amount_cents: fee });
      if (other) payments.push({ stripe_object_id: `${o.id}:other`, kind: "other", amount_cents: other });
      for (const p of payments) {
        Object.assign(p, { currency: o.currency ?? "usd", status: "paid", occurred_at: iso(o.status_transitions?.paid_at ?? o.created) ?? new Date().toISOString() });
      }
      const first = o.billing_reason === "subscription_create";
      return {
        ...empty,
        inquiryId,
        subscriptionId,
        // First invoice paid = admitted (covers ACH, which clears days after checkout).
        inquiryUpdate: first ? { status: "admitted" } : null,
        payments,
        log: { kind: "invoice_paid", detail: { invoice: o.id, amount: o.amount_paid, first } },
      };
    }

    case "invoice.payment_failed": {
      const inquiryId = o.subscription_details?.metadata?.inquiry_id
        ?? o.parent?.subscription_details?.metadata?.inquiry_id ?? null;
      return {
        ...empty,
        inquiryId,
        subscriptionId: o.subscription ?? o.parent?.subscription_details?.subscription ?? null,
        payments: [{
          stripe_object_id: `${o.id}:failed:${o.attempt_count ?? 1}`,
          kind: "rent", amount_cents: o.amount_due ?? 0, currency: o.currency ?? "usd",
          status: "failed", occurred_at: new Date().toISOString(),
        }],
        log: { kind: "payment_failed", detail: { invoice: o.id, attempt: o.attempt_count, next_attempt: o.next_payment_attempt } },
        notifyOperator: "Payment failed",
      };
    }

    case "checkout.session.expired":
      return {
        ...empty,
        inquiryId: o.metadata?.inquiry_id ?? o.client_reference_id ?? null,
        // Bed stays held; operator decides whether to resend or release it.
        inquiryUpdate: { status: "approved", stripe_checkout_url: null },
        log: { kind: "payment_link_expired", detail: { session: o.id } },
        notifyOperator: "Payment link expired without payment",
      };

    case "customer.subscription.deleted":
      return {
        ...empty,
        inquiryId: o.metadata?.inquiry_id ?? null,
        subscriptionId: o.id,
        log: { kind: "subscription_ended", detail: { subscription: o.id, reason: o.cancellation_details?.reason ?? null } },
        notifyOperator: "Autopay ended for a resident",
      };

    default:
      return empty;
  }
}
