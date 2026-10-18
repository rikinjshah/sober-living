-- Resident portal: residents, family access by the resident's consent, drug
-- tests, daily Oura health data and an access log.
--
-- Who sees what:
--   operators  everything (RLS on the tables, as in the intake migration)
--   resident   their own record, through portal_data()
--   family     only what the resident shared, until it expires or is revoked
-- Residents and family never read these tables directly. Every portal read goes
-- through portal_data(), which checks access and writes portal_access_log.
-- People are matched to residents and family grants by their confirmed
-- sign-in email, so nobody needs an invite step beyond the email itself.

create type test_method as enum ('urine_cup', 'urine_lab', 'oral_swab', 'breathalyzer', 'other');
create type test_result as enum ('negative', 'positive', 'dilute', 'invalid', 'refused', 'pending');

-- ---------------------------------------------------------------------------
-- Residents (created automatically when an inquiry is admitted)
-- ---------------------------------------------------------------------------

create table residents (
  id             uuid primary key default gen_random_uuid(),
  inquiry_id     uuid unique references inquiries (id),
  house_id       uuid not null references houses (id),
  full_name      text not null,
  email          text check (email = lower(email)),   -- portal sign-in email
  phone          text,
  move_in_date   date,
  move_out_date  date,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

create unique index residents_email_active_idx on residents (email) where active and email is not null;

-- ---------------------------------------------------------------------------
-- Family access: one row per consent the resident gives
-- ---------------------------------------------------------------------------

create table family_access (
  id              uuid primary key default gen_random_uuid(),
  resident_id     uuid not null references residents (id) on delete cascade,
  email           text not null check (email = lower(email)),
  full_name       text not null,
  relationship    text not null,
  share_tests     boolean not null default false,
  share_health    boolean not null default false,
  share_payments  boolean not null default false,
  purpose         text not null,
  expires_on      date not null,
  consent_text    text not null,         -- the exact wording the resident agreed to
  granted_by      uuid references auth.users (id),
  granted_at      timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_by      text,
  check (share_tests or share_health or share_payments)
);

create unique index family_access_active_idx on family_access (resident_id, email) where revoked_at is null;
create index family_access_email_idx on family_access (email) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Drug tests (entered by the operator or house manager)
-- ---------------------------------------------------------------------------

create table drug_tests (
  id                    uuid primary key default gen_random_uuid(),
  resident_id           uuid not null references residents (id) on delete cascade,
  collected_at          timestamptz not null,
  method                test_method not null,
  panel                 text,                          -- e.g. 12-panel, EtG
  result                test_result not null,
  substances            text[] not null default '{}',  -- what was detected
  prescribed_explained  boolean not null default false, -- detected substance matches a disclosed prescription (e.g. MAT)
  observed              boolean not null default false,
  lab_confirmed         boolean not null default false,
  note                  text,                          -- visible to the resident and to family they share tests with
  entered_by            uuid references auth.users (id) default auth.uid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index drug_tests_resident_idx on drug_tests (resident_id, collected_at desc);

-- Every change to a result is kept, so a result can't be quietly rewritten.
create table drug_test_history (
  id          bigint generated always as identity primary key,
  test_id     uuid not null,
  at          timestamptz not null default now(),
  actor       uuid default auth.uid(),
  op          text not null,
  old_row     jsonb
);

-- ---------------------------------------------------------------------------
-- Oura: tokens (service role only) and one health row per resident per day
-- ---------------------------------------------------------------------------

create table oura_connections (
  resident_id       uuid primary key references residents (id) on delete cascade,
  access_token      text not null,
  refresh_token     text not null,
  token_expires_at  timestamptz not null,
  scopes            text,
  connected_at      timestamptz not null default now(),
  last_synced_at    timestamptz,
  last_error        text
);

create table oura_oauth_states (
  state        text primary key,
  resident_id  uuid not null references residents (id) on delete cascade,
  created_at   timestamptz not null default now()
);

create table health_daily (
  resident_id        uuid not null references residents (id) on delete cascade,
  day                date not null,
  source             text not null default 'oura',
  sleep_score        int,
  readiness_score    int,
  activity_score     int,
  total_sleep_min    int,
  deep_sleep_min     int,
  rem_sleep_min      int,
  light_sleep_min    int,
  awake_min          int,
  sleep_efficiency   int,
  sleep_latency_min  int,
  bedtime_start      timestamptz,
  bedtime_end        timestamptz,
  lowest_hr          int,
  avg_hrv            int,
  steps              int,
  synced_at          timestamptz not null default now(),
  primary key (resident_id, day)
);

-- ---------------------------------------------------------------------------
-- Access log: who looked at whose information, and which parts
-- ---------------------------------------------------------------------------

create table portal_access_log (
  id              bigint generated always as identity primary key,
  at              timestamptz not null default now(),
  viewer_user_id  uuid,
  viewer_email    text,
  viewer_role     text not null,
  resident_id     uuid not null references residents (id) on delete cascade,
  action          text not null,
  detail          jsonb not null default '{}'
);

create index portal_access_log_resident_idx on portal_access_log (resident_id, at desc);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger drug_tests_touch before update on drug_tests
  for each row execute function touch_updated_at();

create or replace function log_drug_test_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into drug_test_history (test_id, op, old_row)
  values (coalesce(old.id, new.id), lower(tg_op), case when tg_op = 'INSERT' then null else to_jsonb(old) end);
  return coalesce(new, old);
end;
$$;

create trigger drug_tests_history after insert or update or delete on drug_tests
  for each row execute function log_drug_test_change();

-- Admitting an inquiry creates the resident; moving out deactivates them.
create or replace function sync_resident_from_inquiry() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'admitted' and old.status is distinct from 'admitted' then
    insert into residents (inquiry_id, house_id, full_name, email, phone, move_in_date)
    values (new.id, new.house_id, new.applicant_name, lower(nullif(trim(new.applicant_email), '')),
            new.applicant_phone, coalesce(new.move_in_date, current_date))
    on conflict (inquiry_id) do update set active = true, move_out_date = null;
  elsif new.status = 'moved_out' and old.status is distinct from 'moved_out' then
    update residents set active = false, move_out_date = coalesce(move_out_date, current_date)
    where inquiry_id = new.id;
  end if;
  return new;
end;
$$;

create trigger inquiries_resident after update on inquiries
  for each row execute function sync_resident_from_inquiry();

-- ---------------------------------------------------------------------------
-- Access functions
-- ---------------------------------------------------------------------------

-- The caller's email, only once Supabase has confirmed they own it.
create or replace function my_email() returns text
language sql stable security definer set search_path = public as $$
  select lower(email) from auth.users where id = auth.uid() and email_confirmed_at is not null;
$$;

create or replace function active_family_grant(p_resident uuid) returns family_access
language sql stable security definer set search_path = public as $$
  select * from family_access
  where resident_id = p_resident and email = my_email()
    and revoked_at is null and expires_on >= current_date
  order by granted_at desc limit 1;
$$;

-- 'operator', 'self', 'family' or null.
create or replace function portal_role(p_resident uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when is_operator() then 'operator'
    when exists (select 1 from residents where id = p_resident and email = my_email()) then 'self'
    when (active_family_grant(p_resident)).id is not null then 'family'
  end;
$$;

-- p_what: 'tests', 'health' or 'payments'.
create or replace function portal_can(p_resident uuid, p_what text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  r text := portal_role(p_resident);
  g family_access;
begin
  if r in ('operator', 'self') then return true; end if;
  if r is null then return false; end if;
  g := active_family_grant(p_resident);
  return case p_what
    when 'tests' then g.share_tests
    when 'health' then g.share_health
    when 'payments' then g.share_payments
    else false end;
end;
$$;

-- Everyone the caller can see in the portal.
create or replace function portal_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', my_email(),
    'is_operator', is_operator(),
    'people', coalesce((
      select jsonb_agg(p order by p->>'role' desc, p->>'name') from (
        select jsonb_build_object('id', r.id, 'name', r.full_name, 'role', 'self',
                                  'tests', true, 'health', true, 'payments', true) as p
        from residents r where r.email = my_email()
        union all
        select jsonb_build_object('id', r.id, 'name', r.full_name, 'role', 'family',
                                  'tests', f.share_tests, 'health', f.share_health,
                                  'payments', f.share_payments, 'expires_on', f.expires_on)
        from family_access f join residents r on r.id = f.resident_id
        where f.email = my_email() and f.revoked_at is null and f.expires_on >= current_date
      ) s), '[]'::jsonb)
  );
$$;

-- One resident's portal page. Logs the view.
create or replace function portal_data(p_resident uuid, p_days int default 30) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  role text := portal_role(p_resident);
  res residents;
  can_tests boolean := portal_can(p_resident, 'tests');
  can_health boolean := portal_can(p_resident, 'health');
  can_pay boolean := portal_can(p_resident, 'payments');
  out jsonb;
begin
  if role is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  p_days := least(greatest(coalesce(p_days, 30), 7), 365);
  select * into res from residents where id = p_resident;

  out := jsonb_build_object(
    'role', role,
    'resident', jsonb_build_object('id', res.id, 'name', res.full_name, 'move_in_date', res.move_in_date,
                                   'active', res.active, 'house', (select name from houses where id = res.house_id)),
    'can', jsonb_build_object('tests', can_tests, 'health', can_health, 'payments', can_pay),
    'days', p_days);

  if can_tests then
    out := out || jsonb_build_object('tests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'collected_at', t.collected_at, 'method', t.method, 'panel', t.panel, 'result', t.result,
               'substances', t.substances, 'prescribed_explained', t.prescribed_explained,
               'observed', t.observed, 'lab_confirmed', t.lab_confirmed, 'note', t.note)
             order by t.collected_at desc)
      from drug_tests t
      where t.resident_id = p_resident and t.collected_at > now() - make_interval(days => p_days)), '[]'::jsonb));
  end if;

  if can_health then
    out := out || jsonb_build_object(
      'health', coalesce((
        select jsonb_agg(to_jsonb(h) - 'resident_id' - 'source' - 'synced_at' order by h.day)
        from health_daily h
        where h.resident_id = p_resident and h.day > current_date - p_days), '[]'::jsonb),
      'oura', (select jsonb_build_object('connected', true, 'last_synced_at', c.last_synced_at,
                                         'needs_reconnect', c.last_error is not null)
               from oura_connections c where c.resident_id = p_resident));
  end if;

  if can_pay then
    out := out || jsonb_build_object('payments', coalesce((
      select jsonb_agg(jsonb_build_object('kind', p.kind, 'amount_cents', p.amount_cents, 'status', p.status,
                                          'period_start', p.period_start, 'period_end', p.period_end,
                                          'occurred_at', p.occurred_at)
             order by p.occurred_at desc)
      from payments p where p.inquiry_id = res.inquiry_id and res.inquiry_id is not null), '[]'::jsonb),
      'has_billing', exists (select 1 from inquiries i where i.id = res.inquiry_id and i.stripe_customer_id is not null));
  end if;

  if role in ('self', 'operator') then
    out := out || jsonb_build_object('family_access', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'email', f.email, 'full_name', f.full_name,
                                          'relationship', f.relationship, 'share_tests', f.share_tests,
                                          'share_health', f.share_health, 'share_payments', f.share_payments,
                                          'expires_on', f.expires_on, 'granted_at', f.granted_at,
                                          'revoked_at', f.revoked_at)
             order by f.granted_at desc)
      from family_access f where f.resident_id = p_resident), '[]'::jsonb));
    -- Residents can see who has looked at their information.
    out := out || jsonb_build_object('recent_views', coalesce((
      select jsonb_agg(jsonb_build_object('at', l.at, 'email', l.viewer_email, 'role', l.viewer_role) order by l.at desc)
      from (select * from portal_access_log l where l.resident_id = p_resident and l.action = 'view'
            and l.viewer_role <> 'self' order by at desc limit 20) l), '[]'::jsonb));
  end if;

  insert into portal_access_log (viewer_user_id, viewer_email, viewer_role, resident_id, action, detail)
  values (auth.uid(), my_email(), role, p_resident, 'view',
          jsonb_build_object('tests', can_tests, 'health', can_health, 'payments', can_pay, 'days', p_days));
  return out;
end;
$$;

-- Only the resident can share their own information.
create or replace function grant_family_access(
  p_resident uuid, p_email text, p_full_name text, p_relationship text,
  p_tests boolean, p_health boolean, p_payments boolean, p_expires_on date
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  e text := lower(trim(coalesce(p_email, '')));
  res residents;
  what text[] := '{}';
  purpose text := 'To keep family informed and involved in support of the resident''s recovery while in sober living';
  consent text;
  new_id uuid;
begin
  if portal_role(p_resident) is distinct from 'self' then
    raise exception 'Only the resident can share their information' using errcode = '42501';
  end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email'; end if;
  if e = my_email() then raise exception 'That is your own email'; end if;
  if coalesce(trim(p_full_name), '') = '' or coalesce(trim(p_relationship), '') = '' then
    raise exception 'Name and relationship are required';
  end if;
  if not (coalesce(p_tests, false) or coalesce(p_health, false) or coalesce(p_payments, false)) then
    raise exception 'Choose at least one thing to share';
  end if;
  if p_expires_on is null or p_expires_on < current_date or p_expires_on > current_date + 366 then
    raise exception 'Choose an end date within the next year';
  end if;

  select * into res from residents where id = p_resident;
  if p_tests then what := what || 'drug and alcohol test results'::text; end if;
  if p_health then what := what || 'sleep and health data from my Oura ring'::text; end if;
  if p_payments then what := what || 'rent and payment history'::text; end if;

  consent := format(
    'I, %s, authorize %s to make the following information about me available to %s (%s, %s): %s. '
    'Purpose: %s. This authorization ends on %s, or sooner if I revoke it, which I can do at any time in '
    'the resident portal. Revoking does not undo information already viewed. My housing does not depend '
    'on signing this. Information shared this way may not be redisclosed without my written consent.',
    res.full_name, (select name from houses where id = res.house_id), trim(p_full_name), trim(p_relationship), e,
    array_to_string(what, ', '), purpose, to_char(p_expires_on, 'FMMonth FMDD, YYYY'));

  update family_access set revoked_at = now(), revoked_by = 'replaced'
  where resident_id = p_resident and email = e and revoked_at is null;

  insert into family_access (resident_id, email, full_name, relationship, share_tests, share_health,
                             share_payments, purpose, expires_on, consent_text, granted_by)
  values (p_resident, e, trim(p_full_name), trim(p_relationship), coalesce(p_tests, false),
          coalesce(p_health, false), coalesce(p_payments, false), purpose, p_expires_on, consent, auth.uid())
  returning id into new_id;

  insert into portal_access_log (viewer_user_id, viewer_email, viewer_role, resident_id, action, detail)
  values (auth.uid(), my_email(), 'self', p_resident, 'grant', jsonb_build_object('family_access_id', new_id, 'to', e));
  return new_id;
end;
$$;

create or replace function revoke_family_access(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  f family_access;
  r text;
begin
  select * into f from family_access where id = p_id;
  r := portal_role(f.resident_id);
  if f.id is null or r not in ('self', 'operator') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  update family_access set revoked_at = now(), revoked_by = r where id = p_id and revoked_at is null;
  insert into portal_access_log (viewer_user_id, viewer_email, viewer_role, resident_id, action, detail)
  values (auth.uid(), my_email(), r, f.resident_id, 'revoke', jsonb_build_object('family_access_id', p_id));
end;
$$;

-- Operator view of Oura connection state (tokens never leave the database).
create or replace function oura_status() returns table (resident_id uuid, connected_at timestamptz,
                                                        last_synced_at timestamptz, last_error text)
language sql stable security definer set search_path = public as $$
  select c.resident_id, c.connected_at, c.last_synced_at, c.last_error
  from oura_connections c where is_operator();
$$;

-- ---------------------------------------------------------------------------
-- Row level security: operators only. Residents and family use the functions.
-- ---------------------------------------------------------------------------

alter table residents          enable row level security;
alter table family_access      enable row level security;
alter table drug_tests         enable row level security;
alter table drug_test_history  enable row level security;
alter table oura_connections   enable row level security;
alter table oura_oauth_states  enable row level security;
alter table health_daily       enable row level security;
alter table portal_access_log  enable row level security;

create policy residents_ops on residents for all to authenticated
  using (is_operator()) with check (is_operator());
create policy family_access_ops on family_access for select to authenticated using (is_operator());
create policy drug_tests_ops on drug_tests for all to authenticated
  using (is_operator()) with check (is_operator());
create policy drug_test_history_ops on drug_test_history for select to authenticated using (is_operator());
create policy health_daily_ops on health_daily for select to authenticated using (is_operator());
create policy portal_access_log_ops on portal_access_log for select to authenticated using (is_operator());
-- oura_connections, oura_oauth_states: service role only (no policies)

revoke all on residents, family_access, drug_tests, drug_test_history, oura_connections,
              oura_oauth_states, health_daily, portal_access_log from anon;

revoke execute on function my_email(), active_family_grant(uuid), portal_role(uuid), portal_can(uuid, text),
  portal_me(), portal_data(uuid, int), grant_family_access(uuid, text, text, text, boolean, boolean, boolean, date),
  revoke_family_access(uuid), oura_status() from public, anon;
grant execute on function portal_role(uuid), portal_can(uuid, text), portal_me(), portal_data(uuid, int),
  grant_family_access(uuid, text, text, text, boolean, boolean, boolean, date),
  revoke_family_access(uuid), oura_status() to authenticated;
revoke execute on function log_drug_test_change(), sync_resident_from_inquiry() from public, anon, authenticated;
