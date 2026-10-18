// Minimal Stripe helpers over the REST API (no SDK), so the same code runs in
// Deno edge functions and in Node tests.

export function formEncode(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") {
          out.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`));
        } else {
          out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (typeof v === "object") {
      out.push(...formEncode(v as Record<string, unknown>, key));
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out;
}

export async function stripeRequest<T = Record<string, unknown>>(
  secretKey: string,
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  idempotencyKey?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const body = formEncode(params).join("&");
  const url = `https://api.stripe.com/v1/${path}` + (method === "GET" && body ? `?${body}` : "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetchImpl(url, { method, headers, body: method === "POST" ? body : undefined });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} failed: ${json?.error?.message ?? res.status}`);
  }
  return json as T;
}

export function billingInterval(days: number): { interval: "week" | "month"; interval_count: number } {
  switch (days) {
    case 7: return { interval: "week", interval_count: 1 };
    case 14: return { interval: "week", interval_count: 2 };
    case 28: return { interval: "week", interval_count: 4 };
    case 30: return { interval: "month", interval_count: 1 };
    default: throw new Error(`Unsupported billing period: ${days} days`);
  }
}

export interface CheckoutInput {
  inquiryId: string;
  customerId: string;
  houseName: string;
  bedLabel: string;
  roomType: "private" | "shared";
  dailyRateCents: number;
  billingDays: number;
  intakeFeeCents: number;
  successUrl: string;
  cancelUrl: string;
}

// Subscription checkout: recurring rent billed in advance from today, plus a
// one-time intake fee on the first invoice. Card or US bank account (ACH).
export function checkoutParams(c: CheckoutInput): Record<string, unknown> {
  const { interval, interval_count } = billingInterval(c.billingDays);
  const periodLabel = c.billingDays === 30 ? "monthly" : c.billingDays === 7 ? "weekly" : `every ${c.billingDays} days`;
  const lineItems: Record<string, unknown>[] = [{
    quantity: 1,
    price_data: {
      currency: "usd",
      unit_amount: c.dailyRateCents * c.billingDays,
      recurring: { interval, interval_count },
      product_data: {
        name: `${c.houseName}: ${c.roomType === "private" ? "private room" : "shared room"} (${c.bedLabel})`,
        description: `$${(c.dailyRateCents / 100).toFixed(0)}/day, billed ${periodLabel}`,
      },
    },
  }];
  if (c.intakeFeeCents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: c.intakeFeeCents,
        product_data: { name: "Intake fee (one-time)" },
      },
    });
  }
  return {
    mode: "subscription",
    customer: c.customerId,
    client_reference_id: c.inquiryId,
    payment_method_types: ["card", "us_bank_account"],
    line_items: lineItems,
    metadata: { inquiry_id: c.inquiryId },
    subscription_data: { metadata: { inquiry_id: c.inquiryId } },
    success_url: c.successUrl,
    cancel_url: c.cancelUrl,
  };
}

// Verifies the Stripe-Signature header (t=...,v1=...) with Web Crypto.
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=", 2) as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
