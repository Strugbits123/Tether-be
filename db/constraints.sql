-- ============================================================================
-- Uniqueness constraints relied on by the service layer.
-- ----------------------------------------------------------------------------
-- Apply via Supabase Dashboard -> SQL Editor, or a `supabase db` migration.
-- ============================================================================

-- One memoir row per user. MemoirService.upsertMemoir performs an atomic
-- upsert on this column (onConflict: 'user_id') to avoid a check-then-insert
-- race that could otherwise double-create rows for a first-time user.
-- Guarded so it's safe to re-run.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'memoirs_user_id_key'
  ) then
    alter table public.memoirs
      add constraint memoirs_user_id_key unique (user_id);
  end if;
end $$;
