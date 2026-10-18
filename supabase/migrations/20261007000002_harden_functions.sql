-- From the Supabase security advisor after the first deploy.
alter function touch_updated_at() set search_path = public;
revoke execute on function is_operator() from public, anon;
grant execute on function is_operator() to authenticated;
revoke execute on function log_inquiry_change() from public, anon, authenticated;
revoke execute on function touch_updated_at() from public, anon, authenticated;
