-- Operator allowlist: an email listed here becomes an operator the first time
-- that person signs in by magic link, so nobody has to invite them by hand.
-- Anyone else who requests a link gets an account with no access (RLS).

create table operator_invites (
  email      text primary key check (email = lower(email)),
  full_name  text not null,
  created_at timestamptz not null default now()
);

alter table operator_invites enable row level security;
-- service role only (no policies)

create or replace function claim_operator_invite() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  inv operator_invites%rowtype;
begin
  select * into inv from operator_invites where email = lower(new.email);
  if found then
    insert into operators (user_id, full_name, email)
    values (new.id, inv.full_name, inv.email)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

revoke execute on function claim_operator_invite() from public, anon, authenticated;

create trigger on_auth_user_created_claim_operator
  after insert on auth.users
  for each row execute function claim_operator_invite();

insert into operator_invites (email, full_name) values ('hello@getsure.org', 'Rikin')
on conflict (email) do nothing;

update houses set operator_email = 'hello@getsure.org' where operator_email is null;
