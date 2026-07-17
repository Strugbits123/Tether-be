-- ============================================================================
-- Atomic write helpers invoked from the backend via supabase.rpc(...)
-- ----------------------------------------------------------------------------
-- These functions each run in an implicit transaction, so a failure part-way
-- through rolls the whole thing back. They replace multi-statement read-then-
-- write patterns in the service layer that were not atomic:
--
--   * replace_content_assignments  — delete + re-insert a content item's
--     assignments in one transaction, so an insert failure preserves the old
--     rows instead of leaving the item unassigned (see ChaptersService).
--
--   * insert_chapter_ordered / insert_exhibit_ordered — compute the next
--     display_order and insert under a per-owner advisory lock, so concurrent
--     creates can't persist duplicate display_order values.
--
-- Apply via Supabase Dashboard -> SQL Editor, or a `supabase db` migration.
-- ============================================================================

-- Atomically replace the assignments for a single content item. -------------
create or replace function replace_content_assignments(
  p_user_id uuid,
  p_content_type text,
  p_content_id uuid,
  p_rows jsonb
) returns setof content_assignments
language plpgsql
as $$
begin
  -- Serialise concurrent replacements of the SAME content item. Without this,
  -- two transactional calls can still interleave their DELETE/INSERT and leave
  -- a merged assignment set rather than a true replacement. The lock is keyed
  -- by content_type + content_id and held until commit.
  perform pg_advisory_xact_lock(
    hashtext('content_assignments:' || p_content_type),
    hashtext(p_content_id::text)
  );

  -- Scope the delete to the owner as well as the content id, so a caller can
  -- never clear another user's assignments for a known content_id.
  delete from content_assignments
    where content_type = p_content_type
      and content_id = p_content_id
      and user_id = p_user_id;

  return query
    insert into content_assignments (
      user_id, content_type, content_id,
      assignment_scope, group_value, recipient_id
    )
    select
      p_user_id,
      p_content_type,
      p_content_id,
      r->>'assignment_scope',
      r->>'group_value',
      nullif(r->>'recipient_id', '')::uuid
    from jsonb_array_elements(p_rows) as r
    returning *;
end;
$$;

-- Insert a chapter with an atomically-assigned display_order. ----------------
-- The advisory lock is held until the transaction commits, serialising
-- concurrent inserts for the same user so max(display_order)+1 is race-free.
create or replace function insert_chapter_ordered(
  p_user_id uuid,
  p_data jsonb
) returns setof chapters
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtext('chapters_display_order'), hashtext(p_user_id::text));

  return query
    insert into chapters (
      user_id, title, date_label, theme, type, status, display_order,
      audio_storage_path, audio_duration_seconds, audio_file_size_bytes,
      audio_mime_type, transcription_status
    )
    values (
      p_user_id,
      p_data->>'title',
      p_data->>'date_label',
      p_data->>'theme',
      coalesce(p_data->>'type', 'text'),
      coalesce(p_data->>'status', 'draft'),
      coalesce((select max(display_order) from chapters where user_id = p_user_id), -1) + 1,
      p_data->>'audio_storage_path',
      (p_data->>'audio_duration_seconds')::int,
      (p_data->>'audio_file_size_bytes')::bigint,
      p_data->>'audio_mime_type',
      p_data->>'transcription_status'
    )
    returning *;
end;
$$;

-- Insert a chapter exhibit with an atomically-assigned display_order. --------
create or replace function insert_exhibit_ordered(
  p_chapter_id uuid,
  p_user_id uuid,
  p_data jsonb
) returns setof chapter_exhibits
language plpgsql
as $$
begin
  -- DB-side ownership check: the chapter must belong to p_user_id. This is a
  -- backstop so the RPC can't attach exhibits to another user's chapter even
  -- if an upstream service-layer guard regresses.
  if not exists (
    select 1 from chapters
      where id = p_chapter_id and user_id = p_user_id
  ) then
    raise exception 'chapter % does not belong to user %', p_chapter_id, p_user_id
      using errcode = 'check_violation';
  end if;

  perform pg_advisory_xact_lock(hashtext('exhibits_display_order'), hashtext(p_chapter_id::text));

  return query
    insert into chapter_exhibits (
      chapter_id, user_id, file_name, storage_path, file_type,
      file_size_bytes, width, height, display_order
    )
    values (
      p_chapter_id,
      p_user_id,
      p_data->>'file_name',
      p_data->>'storage_path',
      p_data->>'file_type',
      (p_data->>'file_size_bytes')::bigint,
      (p_data->>'width')::int,
      (p_data->>'height')::int,
      coalesce((select max(display_order) from chapter_exhibits where chapter_id = p_chapter_id), -1) + 1
    )
    returning *;
end;
$$;

-- Atomically claim the onboarding_abandoned marker. Sets only the
-- onboarding->>'abandoned_at' JSON path (never rewrites the whole object, so a
-- concurrently-completed step isn't clobbered) and only when the user has
-- neither completed nor already-abandoned onboarding. Returns the row when it
-- successfully claimed, zero rows otherwise — the caller fires the analytics
-- event only on a claim, so it can't double-fire.
create or replace function claim_onboarding_abandoned(p_user_id uuid)
returns table (created_at timestamptz, onboarding jsonb)
language sql
as $$
  update public.users
     set onboarding = jsonb_set(
           coalesce(onboarding, '{}'::jsonb),
           '{abandoned_at}',
           to_jsonb(now()::text),
           true
         ),
         updated_at = now()
   where id = p_user_id
     and (onboarding->>'completed_at') is null
     and (onboarding->>'abandoned_at') is null
  returning created_at, onboarding;
$$;

-- Create a batch of photos and their (shared) assignments in one transaction,
-- so a failed assignment insert can't leave orphaned photo rows and a later
-- failure can't leave a partially-committed batch. Returns the created photos.
create or replace function create_photos_with_assignments(
  p_user_id uuid,
  p_photos jsonb,
  p_assignments jsonb,
  p_caption text,
  p_folder_id uuid
) returns setof photos
language plpgsql
as $$
begin
  return query
  with ins as (
    insert into photos (
      user_id, storage_path, storage_path_compressed, file_type,
      file_size_bytes, title, caption, width, height, display_order, folder_id
    )
    select
      p_user_id,
      ph->>'storage_path',
      ph->>'storage_path',
      ph->>'file_type',
      (ph->>'file_size_bytes')::bigint,
      ph->>'title',
      p_caption,
      (ph->>'width')::int,
      (ph->>'height')::int,
      0,
      p_folder_id
    from jsonb_array_elements(p_photos) as ph
    returning *
  ),
  assigned as (
    insert into content_assignments (
      user_id, content_type, content_id,
      assignment_scope, group_value, recipient_id
    )
    select
      p_user_id, 'photo', ins.id,
      a->>'assignment_scope', a->>'group_value',
      nullif(a->>'recipient_id', '')::uuid
    from ins, jsonb_array_elements(p_assignments) as a
    returning 1
  )
  select * from ins;
end;
$$;

-- Create a batch of documents, each with the (shared) assignments, in one
-- transaction. Returns the created documents.
create or replace function create_documents_with_assignments(
  p_user_id uuid,
  p_documents jsonb,
  p_assignments jsonb,
  p_note text
) returns setof documents
language plpgsql
as $$
begin
  return query
  with ins as (
    insert into documents (
      user_id, title, category, note, original_filename, storage_path,
      file_type, file_size_bytes, mime_type
    )
    select
      p_user_id,
      d->>'title',
      coalesce(d->>'category', 'other'),
      p_note,
      d->>'original_filename',
      d->>'storage_path',
      d->>'file_type',
      (d->>'file_size_bytes')::bigint,
      d->>'mime_type'
    from jsonb_array_elements(p_documents) as d
    returning *
  ),
  assigned as (
    insert into content_assignments (
      user_id, content_type, content_id,
      assignment_scope, group_value, recipient_id
    )
    select
      p_user_id, 'document', ins.id,
      a->>'assignment_scope', a->>'group_value',
      nullif(a->>'recipient_id', '')::uuid
    from ins, jsonb_array_elements(p_assignments) as a
    returning 1
  )
  select * from ins;
end;
$$;

-- Atomically complete an onboarding step. Row-locks the user, sets the step's
-- JSON flag, and — only on the true transition to all-five-complete — stamps
-- completed_at. Returns whether THIS call completed onboarding (so the caller
-- emits onboarding_completed / account_activated exactly once), plus created_at
-- and the resulting onboarding json. Concurrent step completions serialize on
-- the row lock, so none is lost and completion can't double-fire.
create or replace function complete_onboarding_step(p_user_id uuid, p_step text)
returns table (just_completed boolean, created_at timestamptz, onboarding jsonb)
language plpgsql
as $$
declare
  v_onb jsonb;
  v_created timestamptz;
  v_was_complete boolean;
  v_now_complete boolean;
  v_just boolean := false;
begin
  select u.onboarding, u.created_at
    into v_onb, v_created
    from public.users u
   where u.id = p_user_id
     for update;

  if not found then
    return; -- no such user; caller treats as no-op
  end if;

  v_onb := coalesce(v_onb, '{}'::jsonb);
  v_was_complete := (v_onb->>'completed_at') is not null;
  v_onb := jsonb_set(v_onb, array[p_step], 'true'::jsonb, true);

  v_now_complete :=
        (v_onb->>'finish_account') = 'true'
    and (v_onb->>'add_release_manager') = 'true'
    and (v_onb->>'add_recipients') = 'true'
    and (v_onb->>'add_photos') = 'true'
    and (v_onb->>'create_message') = 'true';

  if v_now_complete and not v_was_complete then
    v_onb := jsonb_set(v_onb, '{completed_at}', to_jsonb(now()::text), true);
    v_just := true;
  end if;

  update public.users
     set onboarding = v_onb, updated_at = now()
   where id = p_user_id;

  return query select v_just, v_created, v_onb;
end;
$$;

-- Reorder a user's messages transactionally. Updates every (id, display_order)
-- pair scoped to the owner in one statement and fails (rolls back) unless every
-- requested id was updated, so a partial reorder can't commit.
create or replace function reorder_messages(p_user_id uuid, p_order jsonb)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  update public.messages m
     set display_order = (o->>'display_order')::int,
         updated_at = now()
    from jsonb_array_elements(p_order) as o
   where m.id = (o->>'id')::uuid
     and m.user_id = p_user_id;

  get diagnostics v_count = row_count;

  if v_count <> jsonb_array_length(p_order) then
    raise exception 'reorder_messages: updated % of % rows',
      v_count, jsonb_array_length(p_order);
  end if;

  return v_count;
end;
$$;
