-- Run after local_pg_shim.sql: Supabase's auth.users column the portal migration reads.
alter table auth.users add column if not exists email_confirmed_at timestamptz;
