# Sober living platform: intake and payments

The first piece of the platform outlined in `research/platform-mvp.md`. It covers inquiry through admission and rent autopay, so one operator can run the house without chasing paperwork or checks.

The resident portal, family access and drug-test and Oura tracking are documented in [PORTAL.md](PORTAL.md). Upload `sober-living-site.zip`, built by `build_site.sh` from `web/` and `site/`, rather than `sober-living-web.zip`.

## How it works

1. **Inquiry.** A family member, clinician or the person themselves fills in `web/apply.html`. The `intake` function validates and stores it. It emails a confirmation to the person who applied and an alert to the operator.
2. **Screening flags.** Each inquiry gets flags for the operator's call: under 18, needs detox first, under 14 days sober, urgent move-in, came from a treatment program, and so on. Flags never decline anyone; the operator decides. That matters because fair-housing and disability law protect people in recovery, including people on MAT.
3. **Offer a bed.** In `web/operator.html` the operator picks a free bed, confirms the rate and intake fee, and clicks approve. The `admit` function then:
   - creates the Stripe customer and a checkout link (one-time intake fee plus weekly rent on autopay, by card or ACH);
   - emails the link.
4. **Payment.** The `stripe-webhook` function marks the resident admitted when the first payment clears, which for ACH can be a few days later. It records every rent payment and emails the operator if a payment fails or autopay ends.

Everything is logged to a per-inquiry timeline. Row-level security means only people on the `operators` list can see any data. The public form never touches the database directly.

## Defaults chosen (all editable)

| Setting | Default | Where |
|---|---|---|
| House | Petaluma House, 6 residents including the manager | `seed.sql` / `houses` |
| Paying beds | 3 private at $300/day, 2 shared at $225/day (blended $270) | `seed.sql` / `beds` |
| Billing | Weekly in advance, starting at checkout | `houses.billing_days` (7, 14, 28 or 30) |
| Intake fee | $500 one-time | `houses.intake_fee_cents`, overridable per offer |
| Payment methods | Card and US bank account (ACH) | `_shared/stripe.ts` |

The manager's free room has no bed row. No referral payments exist anywhere in the system. "How did you hear about us" is tracking only.

## Layout

```
supabase/migrations/   schema, RLS, triggers, occupancy view
supabase/seed.sql      the proof-of-concept house and beds
supabase/functions/    intake, admit, stripe-webhook (+ _shared logic)
web/                   apply.html, operator.html, welcome.html, config.js
tests/                 deno unit tests + local Postgres RLS test
```

## Live status (2026-10-07)

The Supabase project `sober-living` (`kfpuptsrtihbwjuhroik`, West US) has the schema, the seed data and all three functions deployed. The live intake function was tested end to end. `web/config.js` points at it. Live site: https://sober-living.autumn-brook-0e66.workers.dev. Still to do:
- add the Stripe and email secrets;
- create the operator login;
- re-upload `web/` whenever it changes (Rikin does this; the connector cannot deploy).

## Deploying

What's needed:
- the `sober-living` Supabase project;
- a Stripe account (start in test mode);
- optionally, a Resend account for email (without it, emails are skipped and logged).

1. Apply the migration and seed to the project.
2. Deploy the functions: `intake` and `stripe-webhook` with JWT verification off (each has its own check), and `admit` with it on.
3. Set the function secrets:
   - `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`;
   - `APP_URL`, where `web/` is hosted;
   - `OPERATOR_EMAIL`;
   - `RESEND_API_KEY` and `EMAIL_FROM`.
4. In Stripe, add a webhook to `https://<project>.supabase.co/functions/v1/stripe-webhook` for these events:
   - `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.expired`;
   - `invoice.paid` and `invoice.payment_failed`;
   - `customer.subscription.deleted`.
5. In Supabase Auth, set the Site URL to `APP_URL`. Create the operator's user, then insert them into `operators`.
6. Fill in `web/config.js` with the project URL and anon key. Host `web/` on any static host, such as Netlify, Cloudflare Pages or Vercel.

## Tests

```
deno test tests/                 # validation, screening, Stripe params, signatures, webhook logic
```

`tests/rls_test.sql` runs against a plain Postgres with `tests/local_pg_shim.sql` applied first. It checks:
- anonymous visitors are blocked;
- signed-in non-operators see nothing;
- consent is enforced;
- a bed can't be double-booked;
- status changes are logged.

## Not yet built

- E-signed occupancy agreement and house rules (Dropbox Sign), between approval and payment.
- Texts (Twilio) and automatic follow-ups when an inquiry goes quiet.
- Cancelling autopay from the console on move-out (do it in Stripe for now).
- Add-on purchases (massage, training) and the resident app.
- A privacy lawyer's review before real resident data goes in.

## Deploys

The site deploys automatically: every push to `main` triggers a Cloudflare Workers build on the `sober-living` worker, which runs `build_dist.sh` and publishes `dist/` (see `wrangler.jsonc`). Live at https://soberlivingbayarea.com. `build_site.sh` and the zip are no longer needed.
