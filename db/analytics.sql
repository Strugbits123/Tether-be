-- ============================================================================
-- Columns supporting analytics lifecycle jobs (see AnalyticsCronService).
-- ----------------------------------------------------------------------------
-- Apply via Supabase Dashboard -> SQL Editor, or a `supabase db` migration.
-- ============================================================================

-- Marks the moment the `memoir_abandoned` event was fired for a memoir, so the
-- daily cron fires it at most once per abandonment (cleared implicitly by never
-- re-firing while set; reset it manually if you want to re-arm).
-- onboarding_abandoned uses users.onboarding->>'abandoned_at' (JSON) instead and
-- needs no column.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'memoirs'
        and column_name = 'abandoned_at'
  ) then
    alter table public.memoirs add column abandoned_at timestamptz;
  end if;
end $$;
