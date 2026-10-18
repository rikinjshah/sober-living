# Public website and resident portal

Built 2026-10-07. The second piece of the platform, after intake and payments (see README.md).

## What's here

| Page | Who | What it does |
|---|---|---|
| `/` | Everyone | Home page for families and referrers: what's included, structure, family portal, a section for treatment teams, FAQ. Replaces the old redirect to `/apply`. |
| `/apply` | Everyone | The existing inquiry form, unchanged. It stays public so discharge planners can refer without an account. |
| `/login` | Residents, family, staff | Email sign-in link, no password. Sends staff to a choice of intake and payments (`/operator`) or residents (`/residents`). Sends residents and family straight to the portal. |
| `/portal` | Residents, family with consent, staff | Overview, test results, sleep and health (Oura), payments with a Stripe link to update the card, and sharing. |
| `/residents` | Staff | Resident list, record a drug test, Oura status, family access, open any resident's portal. |
| `/privacy` | Everyone | Draft privacy notice, for a lawyer to review. |

## How access works

- People are matched by their **confirmed sign-in email**. A resident's portal email is set from the inquiry when they're admitted; staff can change it on `/residents`.
- **Family see nothing until the resident shares.** On the Sharing tab the resident picks the person, what they can see (tests, sleep and health, payments) and an end date within a year, and ticks an authorization. The exact consent wording is stored with each grant. The resident can stop sharing at any time, and so can staff.
- Residents and family never read tables directly. Every portal view goes through `portal_data()`, which checks access and writes `portal_access_log`. Residents can see who else has viewed their page.
- Staff can edit a test result, but every change keeps the previous version in `drug_test_history`.
- A positive result that matches a disclosed prescription, such as buprenorphine for MAT, can be marked so; it shows as "Prescribed medication", not "Positive".
- Oura: each resident connects their own ring. Tokens sit in a table only the server can read. An hourly job pulls the last few days, and if the connection lapses the resident is asked to reconnect.
- When an inquiry is marked admitted, a resident record is created automatically. Marking it moved out deactivates the record.

## Files

```
site/                          home, login, portal, residents, privacy pages + app.js, site.css
build_site.sh                  merges web/ and site/ into sober-living-site.zip for upload
supabase/migrations/..._000003_resident_portal.sql, ..._000005_resident_portal_harden.sql
supabase/functions/oura-connect, oura-callback, oura-sync, billing-portal, _shared/oura.ts
tests/oura_test.ts, tests/portal_test.sql, tests/portal_pg_shim.sql
```

## Live status

The migrations and all four functions are deployed to the `sober-living` Supabase project. Smoke tests: the signed-in functions reject anonymous calls, and the Oura callback redirects to the portal. The pages are built into `sober-living-site.zip` but are not live until uploaded.

## Setup still needed (Rikin)

1. **Upload `sober-living-site.zip`** to the Cloudflare worker in place of `sober-living-web.zip`. It includes the existing intake and operator pages.
2. **Supabase, Authentication, URL configuration:**
   - set the Site URL to `https://soberlivingbayarea.com` and add `https://soberlivingbayarea.com/login` and `https://soberlivingbayarea.com/operator` to the redirect URLs;
   - keep email sign-ups enabled, so family members can sign in. A new account sees nothing unless a resident has shared with that email.
3. **Oura:**
   - create an app at https://cloud.ouraring.com/oauth/applications with the redirect URI `https://kfpuptsrtihbwjuhroik.supabase.co/functions/v1/oura-callback`;
   - add the function secrets `OURA_CLIENT_ID` and `OURA_CLIENT_SECRET`.
   - Each ring needs an active Oura Membership (about $6 a month) for its data to reach the API, so budget for that alongside the ring.
4. **Hourly sync:**
   - add a function secret `CRON_SECRET` (any long random string);
   - in Supabase, Integrations, Cron, create an hourly job that POSTs to `/functions/v1/oura-sync` with the header `x-cron-secret: <that string>`.
   - Until then, the sync refuses every call.
5. **Stripe:** turn on the customer portal (Settings, Billing, Customer portal), so "Update card or bank" works.

## Tests

```
deno test tests/      # includes the Oura mapping, paging and 401 handling
# Postgres: local_pg_shim.sql, portal_pg_shim.sql, all migrations, seed.sql, then portal_test.sql
```

`portal_test.sql` checks the following:
- strangers and unconfirmed emails see nothing;
- family can't grant or revoke access;
- family see only what was shared, and lose it on revoke;
- edits to a result are kept;
- tokens are hidden from staff;
- moving out deactivates the resident.

## Privacy and compliance (needs a lawyer before real data)

These are my reading, not legal advice.

- **42 CFR Part 2** covers federally assisted programs that diagnose, treat or refer for substance use disorder. A private-pay sober home that provides no treatment is probably not a Part 2 program. Results that come from a Part 2 program, such as an IOP's lab, still carry its no-redisclosure rule. The consent form includes Part 2's elements anyway: who, what, purpose, end date, revocation and a redisclosure notice.
- **HIPAA** likely doesn't apply while the house doesn't bill insurance. That changes if it ever does. A lab that runs confirmations needs the resident's own authorization to send results to the house.
- **California CMIA** (Civil Code 56.06) treats a business that offers software for people to manage their own medical information as a provider. The portal likely falls under it. That makes written authorization before sharing essential, which the consent flow covers, and it carries penalties for unauthorized disclosure. Have the lawyer check the consent wording against Civil Code 56.11.
- **FTC Health Breach Notification Rule** (amended 2024) covers apps that pull health data from a wearable plus user input. A breach means notifying residents and the FTC.
- **Fair housing:** apply testing to every resident the same way, and treat prescribed MAT as allowed.
- **Wording:** the site says "residents", not "patients". "Patient portal" language suggests treatment, which is what the plan avoids so it doesn't need a DHCS license.
- **Later hardening:**
  - move Oura tokens into Supabase Vault;
  - consider Supabase's HIPAA add-on and BAA;
  - set a retention period and delete data after move-out.
