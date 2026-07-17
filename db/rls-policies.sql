-- ============================================================================
-- Row-Level Security backstop for user-owned tables  (addresses audit C2)
-- ----------------------------------------------------------------------------
-- The backend currently accesses Postgres with the Supabase SERVICE-ROLE key,
-- which BYPASSES RLS. Enabling RLS therefore does NOT change current backend
-- behaviour — it is a defense-in-depth safety net that takes effect the moment
-- any anon/publishable-key path (or direct client access) is introduced.
--
-- Ownership rule: a row is visible/writable only to the user it belongs to
-- (auth.uid() = user_id), matching the manual .eq('user_id', ...) filters in
-- the service layer.
--
-- Apply via Supabase Dashboard → SQL Editor, or `supabase db` migration.
-- Review before running in production.
-- ============================================================================

-- Tables keyed on a `user_id` column ----------------------------------------
do $$
declare
  t text;
  user_owned text[] := array[
    'messages',
    'chapters',
    'chapter_exhibits',
    'chapter_tts',
    'memoirs',
    'content_assignments',
    'recipients',
    'release_managers',
    'photos',
    'photo_folders',
    'documents',
    'feedback',
    'activity_log'
  ];
begin
  foreach t in array user_owned loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %I on public.%I;', t || '_owner_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (auth.uid() = user_id) with check (auth.uid() = user_id);',
      t || '_owner_all', t
    );
  end loop;
end $$;

-- users: owned via `id` (not user_id) ---------------------------------------
alter table public.users enable row level security;
drop policy if exists users_self_all on public.users;
create policy users_self_all on public.users for all to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- ----------------------------------------------------------------------------
-- NOT covered here (own ownership model — release-manager / recipient portal /
-- guardian / billing / admin tables). These need policies written against their
-- specific access rules before RLS is relied upon for them:
--   release_plans, recipient_delivery_status, recipient_sessions, guardians,
--   guardian_escalations, notification_log, payments, gift_cards,
--   discount_codes, data_export_requests, email_change_requests, announcements,
--   announcement_dismissals, audit_log, help_articles, memoir_chapters.
-- ----------------------------------------------------------------------------
