-- Run after local_pg_shim.sql, portal_pg_shim.sql, the migrations and seed (see README).
\set ON_ERROR_STOP 1
insert into auth.users values
 ('11111111-1111-1111-1111-111111111111','op@example.com', now()),
 ('33333333-3333-3333-3333-333333333333','res@example.com', now()),
 ('44444444-4444-4444-4444-444444444444','mom@example.com', now()),
 ('55555555-5555-5555-5555-555555555555','stranger@example.com', now()),
 ('66666666-6666-6666-6666-666666666666','unconfirmed@example.com', null);
insert into operators values ('11111111-1111-1111-1111-111111111111','Op','op@example.com');

-- Admitting an inquiry creates the resident
insert into inquiries (house_id, submitted_by, contact_name, contact_email, applicant_name, applicant_email, consent_contact, consent_privacy)
values ((select id from houses limit 1),'family','Mom','mom@example.com','Sam','Res@Example.com',true,true) returning id as inq \gset
update inquiries set status='admitted' where id = :'inq';
select id as rid from residents where inquiry_id = :'inq' \gset
select 'resident email', email from residents where id = :'rid';
insert into drug_tests (resident_id, collected_at, method, panel, result) values (:'rid', now() - interval '1 day', 'urine_cup', '12-panel', 'negative');
insert into drug_tests (resident_id, collected_at, method, result, substances, prescribed_explained) values (:'rid', now(), 'oral_swab', 'positive', '{buprenorphine}', true);
insert into health_daily (resident_id, day, sleep_score, total_sleep_min) values (:'rid', current_date, 82, 431);
insert into payments (inquiry_id, stripe_object_id, kind, amount_cents, status) values (:'inq', 'in_1', 'rent', 210000, 'paid');

create function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', uid, false); end $$;

set role authenticated;
-- stranger: no people, portal_data refused, no direct table reads
select pg_temp.as_user('55555555-5555-5555-5555-555555555555');
select 'stranger people', portal_me()->'people';
do $$ begin perform portal_data((select null::uuid)); exception when insufficient_privilege then raise notice 'ok: null resident refused'; end $$;
select 'stranger role (expect empty)', portal_role(:'rid');
select 'stranger sees drug_tests rows', count(*) from drug_tests;
select 'stranger sees health rows', count(*) from health_daily;

-- resident sees everything about themselves
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select 'resident people', portal_me()->'people';
select 'resident data keys', (select array_agg(k order by k) from jsonb_object_keys(portal_data(:'rid')) k);
select 'resident sees tests', jsonb_array_length(portal_data(:'rid')->'tests');
-- family can't see anything yet
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select 'mom before consent', portal_role(:'rid');
do $$ begin
  perform grant_family_access((select id from residents limit 1), 'x@y.com','X','friend', true,false,false, current_date+30);
  raise exception 'FAIL: family granted itself access';
exception when insufficient_privilege then raise notice 'ok: only the resident can grant'; end $$;

-- resident grants health only
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select grant_family_access(:'rid', 'MOM@example.com', 'Ann', 'Mother', false, true, false, current_date + 90) as gid \gset
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select 'mom role', portal_role(:'rid');
select 'mom can', portal_data(:'rid')->'can';
select 'mom has tests key', portal_data(:'rid') ? 'tests', 'has health', portal_data(:'rid') ? 'health', 'has family list', portal_data(:'rid') ? 'family_access';
do $$ begin perform revoke_family_access((select id from family_access limit 1)); raise exception 'FAIL: family revoked'; exception when insufficient_privilege then raise notice 'ok: family cannot revoke'; end $$;

-- unconfirmed email with same address as resident would get nothing
select pg_temp.as_user('66666666-6666-6666-6666-666666666666');
select 'unconfirmed people', portal_me()->'people';

-- resident revokes
select pg_temp.as_user('33333333-3333-3333-3333-333333333333');
select revoke_family_access(:'gid');
select 'resident sees views by others', jsonb_array_length(portal_data(:'rid')->'recent_views');
select pg_temp.as_user('44444444-4444-4444-4444-444444444444');
select 'mom after revoke', portal_role(:'rid');

-- operator: table access and edits are logged
select pg_temp.as_user('11111111-1111-1111-1111-111111111111');
select 'operator sees tests', count(*) from drug_tests;
update drug_tests set result='dilute' where result='negative';
select 'history rows', count(*) from drug_test_history;
select 'oura tokens visible to operator', count(*) from oura_connections;
reset role;
select 'log', viewer_role, action, count(*) from portal_access_log group by 1,2,3 order by 2,3;
-- moving out deactivates
update inquiries set status='moved_out' where id = :'inq';
select 'active after move out', active from residents where id = :'rid';
