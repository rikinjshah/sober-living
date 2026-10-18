-- Proof-of-concept house: 6 residents including the live-in house manager,
-- who has a free room and no bed row. Five paying beds.
-- Blended rate: (3 x $300 + 2 x $225) / 5 = $270/day.

insert into houses (id, name, city, max_residents, intake_fee_cents, billing_days)
values ('00000000-0000-0000-0000-000000000001', 'Petaluma House', 'Petaluma', 6, 50000, 7)
on conflict (id) do nothing;

insert into beds (house_id, label, room_type, daily_rate_cents) values
  ('00000000-0000-0000-0000-000000000001', 'Room 1',   'private', 30000),
  ('00000000-0000-0000-0000-000000000001', 'Room 2',   'private', 30000),
  ('00000000-0000-0000-0000-000000000001', 'Room 3',   'private', 30000),
  ('00000000-0000-0000-0000-000000000001', 'Room 4 A', 'shared',  22500),
  ('00000000-0000-0000-0000-000000000001', 'Room 4 B', 'shared',  22500)
on conflict (house_id, label) do nothing;
