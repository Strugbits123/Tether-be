-- ============================================================================
-- Cached Mux static-rendition state for video message downloads.
-- ----------------------------------------------------------------------------
-- The RM video-download page needs to know whether a downloadable MP4 exists
-- for each video. Asking Mux per video per page load meant one upstream call
-- for every assigned video, repeated on every poll while renditions were still
-- transcoding — the page polls precisely when it's most expensive.
--
-- Mux already tells us when this changes, via the
-- video.asset.static_rendition.* webhooks. These columns store what it tells
-- us, so listVideos reads the database and only falls back to the Mux API for
-- rows whose state is genuinely unknown (null) — i.e. assets that predate this
-- and haven't emitted an event yet.
--
-- Apply via Supabase Dashboard -> SQL Editor. Idempotent and additive: existing
-- rows get NULL, which the service treats as "unknown, ask Mux once".
-- ============================================================================

-- null = unknown (never asked / no webhook yet). Otherwise mirrors the status
-- Mux reports for the 'highest.mp4' rendition.
alter table public.messages
  add column if not exists mux_static_rendition_status text;

do $$
begin
  if exists (
    select 1 from pg_constraint
      where conname = 'messages_mux_static_rendition_status_check'
        and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      drop constraint messages_mux_static_rendition_status_check;
  end if;

  alter table public.messages
    add constraint messages_mux_static_rendition_status_check
    check (
      mux_static_rendition_status is null
      or mux_static_rendition_status in ('preparing', 'ready', 'errored', 'skipped')
    );
end $$;

-- Cached alongside the status so the download page can show a file size without
-- a Mux round-trip. Mux reports filesize as a string; stored as bigint.
alter table public.messages
  add column if not exists mux_static_rendition_bytes bigint;

-- Only video rows are ever queried by rendition status, and only those still
-- awaiting a rendition are interesting.
create index if not exists messages_static_rendition_pending_idx
  on public.messages (user_id)
  where type = 'video' and mux_static_rendition_status is distinct from 'ready';
