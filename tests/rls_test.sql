\set ON_ERROR_STOP 1
insert into auth.users values ('11111111-1111-1111-1111-111111111111','op@example.com'),('22222222-2222-2222-2222-222222222222','rando@example.com');
insert into operators values ('11111111-1111-1111-1111-111111111111','Op','op@example.com');

-- service role inserts an inquiry (as the intake function does)
set role service_role;
insert into inquiries (house_id, submitted_by, contact_name, contact_email, applicant_name, consent_contact, consent_privacy, screening_flags)
values ('00000000-0000-0000-0000-000000000001','self','Jo','jo@x.com','Jo',true,true,'{urgent_move_in}') returning id \gset
insert into inquiries (house_id, submitted_by, contact_name, contact_email, applicant_name, consent_contact, consent_privacy)
values ('00000000-0000-0000-0000-000000000001','family','Ann','ann@x.com','Sam',true,true) returning id as id2 \gset
reset role;

-- consent must be true
do $$ begin
  insert into inquiries (house_id, submitted_by, contact_name, contact_email, applicant_name, consent_contact, consent_privacy)
  values ('00000000-0000-0000-0000-000000000001','self','X','x@x.com','X',false,true);
  raise exception 'FAIL: consent check missing';
exception when check_violation then raise notice 'ok: consent enforced'; end $$;

-- anon sees nothing / cannot read
set role anon;
do $$ begin perform count(*) from inquiries; raise exception 'FAIL anon read'; exception when insufficient_privilege then raise notice 'ok: anon blocked'; end $$;
reset role;

-- random signed-in user sees zero rows
set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select 'non-operator sees', count(*) from inquiries;
update inquiries set status='admitted';  -- should affect 0 rows
reset role;
select 'statuses after rando update', string_agg(status::text, ',') from inquiries;

-- operator sees and updates
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 'operator sees', count(*) from inquiries;
select id as bed1 from beds where label='Room 1' \gset
update inquiries set status='approved', bed_id=:'bed1', daily_rate_cents=30000 where id=:'id';
-- double booking the same bed must fail
do $$ declare b uuid; i uuid; begin
  select id into b from beds where label='Room 1';
  select id into i from inquiries where applicant_name='Sam';
  update inquiries set status='approved', bed_id=b where id=i;
  raise exception 'FAIL: double booking allowed';
exception when unique_violation then raise notice 'ok: bed double-booking blocked'; end $$;
select 'occupancy', admitted, pending, waitlist from house_occupancy;
select 'events', kind, actor, detail from inquiry_events where inquiry_id=:'id' order by at, id;
select 'payments visible', count(*) from payments;
reset role;
