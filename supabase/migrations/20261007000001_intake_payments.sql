-- Intake and payments: the first piece of the sober living operating platform.
-- Public visitors never touch these tables directly. The intake edge function
-- writes with the service role after validating; operators read and update
-- through RLS once signed in.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type room_type as enum ('private', 'shared');

create type inquiry_status as enum (
  'new',           -- submitted, not yet looked at
  'reviewing',     -- operator is screening / has a call booked
  'approved',      -- operator approved, bed and rate assigned
  'payment_sent',  -- Stripe checkout link sent
  'admitted',      -- intake fee + first week paid, autopay active
  'waitlist',      -- good fit, no bed yet
  'declined',
  'withdrawn',
  'moved_out'
);

create type payment_kind as enum ('intake_fee', 'rent', 'addon', 'refund', 'other');

-- ---------------------------------------------------------------------------
-- Operators (people allowed into the back office)
-- ---------------------------------------------------------------------------

create table operators (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null,
  email      text not null,
  created_at timestamptz not null default now()
);

create or replace function is_operator() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from operators where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Houses and beds
-- ---------------------------------------------------------------------------

create table houses (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  city              text not null,
  max_residents     int  not null default 6 check (max_residents > 0),
  intake_fee_cents  int  not null default 50000 check (intake_fee_cents >= 0),
  billing_days      int  not null default 7 check (billing_days in (7, 14, 28, 30)),
  operator_email    text,
  created_at        timestamptz not null default now()
);

create table beds (
  id                uuid primary key default gen_random_uuid(),
  house_id          uuid not null references houses (id) on delete cascade,
  label             text not null,
  room_type         room_type not null,
  daily_rate_cents  int not null check (daily_rate_cents > 0),
  active            boolean not null default true,
  unique (house_id, label)
);

-- ---------------------------------------------------------------------------
-- Inquiries (one row per applicant, carried through to admission)
-- ---------------------------------------------------------------------------

create table inquiries (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  house_id              uuid not null references houses (id),
  status                inquiry_status not null default 'new',

  -- Who filled in the form
  submitted_by          text not null check (submitted_by in ('self', 'family', 'professional')),
  contact_name          text not null,
  contact_email         text not null,
  contact_phone         text,
  contact_relationship  text,
  contact_organization  text,

  -- The prospective resident
  applicant_name        text not null,
  applicant_email       text,
  applicant_phone       text,
  applicant_age         int check (applicant_age between 0 and 120),

  -- Fit
  preferred_room        room_type,
  desired_move_in       date,
  current_setting       text check (current_setting in
                          ('residential_treatment', 'detox', 'iop_php', 'home',
                           'other_sober_living', 'other')),
  treatment_program     text,
  expected_discharge    date,
  sobriety_date         date,
  needs_medical_detox   boolean not null default false,
  heard_about_us        text check (heard_about_us in
                          ('treatment_program', 'clinician', 'attorney',
                           'monitoring_program', 'alumni', 'family_friend',
                           'search', 'other')),
  heard_about_us_detail text,
  message               text,

  -- Consent captured at submission
  consent_contact       boolean not null check (consent_contact),
  consent_privacy       boolean not null check (consent_privacy),

  -- Screening (computed by the intake function; never auto-declines)
  screening_flags       text[] not null default '{}',

  -- Admission
  bed_id                uuid references beds (id),
  daily_rate_cents      int check (daily_rate_cents > 0),
  intake_fee_cents      int check (intake_fee_cents >= 0),
  move_in_date          date,
  stripe_customer_id    text,
  stripe_checkout_id    text,
  stripe_checkout_url   text,
  stripe_subscription_id text,
  operator_notes        text
);

create index inquiries_status_idx on inquiries (status, created_at desc);
create index inquiries_house_idx on inquiries (house_id);
create unique index inquiries_checkout_idx on inquiries (stripe_checkout_id) where stripe_checkout_id is not null;
create index inquiries_subscription_idx on inquiries (stripe_subscription_id) where stripe_subscription_id is not null;

-- A bed holds at most one approved/admitted resident at a time.
create unique index inquiries_bed_occupied_idx on inquiries (bed_id)
  where bed_id is not null and status in ('approved', 'payment_sent', 'admitted');

-- ---------------------------------------------------------------------------
-- Timeline / audit log
-- ---------------------------------------------------------------------------

create table inquiry_events (
  id          bigint generated always as identity primary key,
  inquiry_id  uuid not null references inquiries (id) on delete cascade,
  at          timestamptz not null default now(),
  kind        text not null,
  actor       text not null default 'system',
  detail      jsonb not null default '{}'
);

create index inquiry_events_inquiry_idx on inquiry_events (inquiry_id, at);

-- ---------------------------------------------------------------------------
-- Payments (mirrors Stripe; Stripe stays the source of truth)
-- ---------------------------------------------------------------------------

create table payments (
  id                uuid primary key default gen_random_uuid(),
  inquiry_id        uuid references inquiries (id),
  stripe_object_id  text not null unique,   -- invoice or payment intent id
  kind              payment_kind not null,
  amount_cents      int not null,
  currency          text not null default 'usd',
  status            text not null,          -- paid | failed | refunded
  period_start      timestamptz,
  period_end        timestamptz,
  occurred_at       timestamptz not null default now(),
  raw               jsonb not null default '{}'
);

create index payments_inquiry_idx on payments (inquiry_id, occurred_at desc);

-- Stripe webhook idempotency
create table stripe_events (
  id           text primary key,
  type         text not null,
  received_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Triggers: updated_at and status-change logging
-- ---------------------------------------------------------------------------

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger inquiries_touch before update on inquiries
  for each row execute function touch_updated_at();

create or replace function log_inquiry_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who text := coalesce((select email from operators where user_id = auth.uid()), 'system');
begin
  if tg_op = 'INSERT' then
    insert into inquiry_events (inquiry_id, kind, actor, detail)
    values (new.id, 'submitted', 'applicant',
            jsonb_build_object('flags', new.screening_flags));
  elsif new.status is distinct from old.status then
    insert into inquiry_events (inquiry_id, kind, actor, detail)
    values (new.id, 'status_changed', who,
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end;
$$;

create trigger inquiries_log after insert or update on inquiries
  for each row execute function log_inquiry_change();

-- ---------------------------------------------------------------------------
-- Occupancy view for the operator dashboard
-- ---------------------------------------------------------------------------

create view house_occupancy with (security_invoker = true) as
select
  h.id as house_id,
  h.name,
  h.max_residents,
  count(i.id) filter (where i.status = 'admitted')                    as admitted,
  count(i.id) filter (where i.status in ('approved', 'payment_sent')) as pending,
  count(i.id) filter (where i.status = 'waitlist')                    as waitlist
from houses h
left join inquiries i on i.house_id = h.id
group by h.id;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table operators      enable row level security;
alter table houses         enable row level security;
alter table beds           enable row level security;
alter table inquiries      enable row level security;
alter table inquiry_events enable row level security;
alter table payments       enable row level security;
alter table stripe_events  enable row level security;

create policy operators_self on operators for select to authenticated
  using (is_operator());

create policy houses_ops on houses for all to authenticated
  using (is_operator()) with check (is_operator());

create policy beds_ops on beds for all to authenticated
  using (is_operator()) with check (is_operator());

create policy inquiries_ops_select on inquiries for select to authenticated
  using (is_operator());
create policy inquiries_ops_update on inquiries for update to authenticated
  using (is_operator()) with check (is_operator());

create policy events_ops_select on inquiry_events for select to authenticated
  using (is_operator());
create policy events_ops_insert on inquiry_events for insert to authenticated
  with check (is_operator());

create policy payments_ops_select on payments for select to authenticated
  using (is_operator());

-- stripe_events: service role only (no policies)

revoke all on all tables in schema public from anon;
revoke execute on function is_operator() from anon;
