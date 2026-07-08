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
  delete from content_assignments
    where content_type = p_content_type
      and content_id = p_content_id;

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
