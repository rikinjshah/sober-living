-- From the Supabase security advisor: Supabase grants execute to authenticated
-- explicitly, so the helper functions need their own revoke.
revoke execute on function my_email(), active_family_grant(uuid) from authenticated;
