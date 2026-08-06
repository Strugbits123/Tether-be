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
  -- Scope the lookup to public.memoirs by conrelid, not conname alone — a
  -- same-named constraint on another table must not make this block skip
  -- creating the constraint memoirs.user_id still needs.
  if not exists (
    select 1 from pg_constraint
      where conname = 'memoirs_user_id_key'
        and conrelid = 'public.memoirs'::regclass
  ) then
    alter table public.memoirs
      add constraint memoirs_user_id_key unique (user_id);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- One live Guardian per priority slot — and therefore a race-free cap.
-- ----------------------------------------------------------------------------
-- GuardiansService.create and AccessService.designateGuardianInternal both check
-- capacity and then write, which is a read-then-write race: two concurrent
-- designations can each see one free slot and both insert. supabase-js can't open
-- a transaction across statements, so the database has to be the authority.
--
-- This index is the whole guarantee. Slots are only ever assigned by
-- nextPriorityOrder, which returns values in 1..MAX_GUARDIANS — so uniqueness on
-- (account_id, priority_order) over live rows caps the number of live Guardians
-- at MAX_GUARDIANS as a side effect. No separate count constraint or RPC is
-- needed; the service-layer checks remain purely so the common path returns a
-- clean 409 instead of a raw constraint error.
--
-- Partial because revoked/declined/bounced rows are kept for audit and a
-- re-designation must be able to reuse the slot they occupied.
--
-- NOTE: MAX_GUARDIANS is currently 2 (src/guardians/guardians.constants.ts). If
-- it is ever lowered, existing rows holding a now-out-of-range slot must be
-- reconciled first — this index constrains uniqueness, not the range.
create unique index if not exists guardians_live_priority_uniq
  on public.guardians (account_id, priority_order)
  where status not in ('revoked', 'declined', 'bounced');

-- ----------------------------------------------------------------------------
-- documents.category / documents.file_type must accept everything the service
-- layer can produce.
-- ----------------------------------------------------------------------------
-- Both were found narrower in the databases than in the code, each surfacing as
-- an opaque 500 from POST /documents/batch. Verified live at the time of writing:
-- production accepts all values below; STAGING still rejects file_type 'doc' and
-- 'm4v', so .doc uploads fail there until this is applied.
--
-- Keep these lists in sync with MIME_TO_EXT and the @IsIn on DocumentItemDto
-- (create-documents-batch.dto.ts) — all three must agree.
do $$
begin
  if exists (
    select 1 from pg_constraint
      where conname = 'documents_category_check'
        and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents drop constraint documents_category_check;
  end if;

  alter table public.documents
    add constraint documents_category_check
    check (category in (
      'legal', 'financial', 'insurance', 'medical', 'property',
      'digital_accounts', 'personal', 'military', 'other'
    ));
end $$;

do $$
begin
  if exists (
    select 1 from pg_constraint
      where conname = 'documents_file_type_check'
        and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents drop constraint documents_file_type_check;
  end if;

  alter table public.documents
    add constraint documents_file_type_check
    check (file_type in (
      'pdf', 'docx', 'doc', 'jpg', 'jpeg', 'png', 'heic',
      'mp3', 'm4a', 'wav', 'ogg', 'aac', 'webm', 'mp4', 'mov', 'm4v', 'avi', 'mpeg'
    ));
end $$;
