-- ============================================================================
-- Schema the release-plan flow requires but which was never migrated.
-- ----------------------------------------------------------------------------
-- ReleasePlanService was written against columns that don't exist in either
-- environment, so the flow currently cannot complete at all:
--
--   * release_plans.cancel_token   — initiateRelease INSERTs it, so every
--     initiate attempt fails outright. It also backs the account owner's
--     cancel-by-email link (release-cancel.controller.ts + cancelByToken),
--     which is the safety valve on the entire release.
--
--   * guardian_escalations.guardian_id / .status — requestGuardianEscalation
--     INSERTs both, so escalation always 500s.
--
-- Apply via Supabase Dashboard -> SQL Editor. Idempotent: safe to re-run, and
-- safe to apply ahead of the code deploy (every change is additive — no
-- existing insert or read can start failing because of it).
--
-- Verified before writing: neither environment has any release_plans or
-- guardian_escalations rows, so no backfill is required.
-- ============================================================================

-- release_plans.cancel_token -------------------------------------------------
-- Unguessable token emailed to the account owner at initiation. Nullable so
-- the column can be added to any pre-existing row; new rows always get one
-- from the service. Unique because cancelByToken looks a plan up by it alone —
-- a collision would let one owner cancel another's release.
alter table public.release_plans
  add column if not exists cancel_token uuid;

create unique index if not exists release_plans_cancel_token_uniq
  on public.release_plans (cancel_token)
  where cancel_token is not null;

-- guardian_escalations.guardian_id / .status ---------------------------------
-- Which guardian was escalated to, and where that request stands. The table is
-- currently write-only, but this is audit data for a legally-sensitive handover
-- — recording the target guardian matters even if nothing reads it yet.
alter table public.guardian_escalations
  add column if not exists guardian_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
      where conname = 'guardian_escalations_guardian_id_fkey'
        and conrelid = 'public.guardian_escalations'::regclass
  ) then
    alter table public.guardian_escalations
      add constraint guardian_escalations_guardian_id_fkey
      foreign key (guardian_id) references public.guardians(id) on delete set null;
  end if;
end $$;

alter table public.guardian_escalations
  add column if not exists status text not null default 'pending';

-- Keep in sync with the values requestGuardianEscalation can write. 'pending'
-- is the only one the code sets today; the rest are the intended lifecycle and
-- are included so a follow-up doesn't need another migration.
do $$
begin
  if exists (
    select 1 from pg_constraint
      where conname = 'guardian_escalations_status_check'
        and conrelid = 'public.guardian_escalations'::regclass
  ) then
    alter table public.guardian_escalations
      drop constraint guardian_escalations_status_check;
  end if;

  alter table public.guardian_escalations
    add constraint guardian_escalations_status_check
    check (status in ('pending', 'accepted', 'declined', 'expired', 'cancelled'));
end $$;

create index if not exists guardian_escalations_account_idx
  on public.guardian_escalations (account_id, sent_at desc);
