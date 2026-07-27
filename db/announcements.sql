-- Backs RmNotificationsService (src/rm-portal/rm-notifications.service.ts):
-- system-wide notices shown in the RM/guardian notification bell, with a
-- per-user dismissal/read-tracking table.

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  target_audience text not null default 'all',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The table above may already have existed (pre-dating this feature) without
-- these columns — add them if missing rather than assuming a fresh create.
alter table public.announcements add column if not exists title text;
alter table public.announcements add column if not exists category text; -- 'recommendation' | 'feature' | 'security_alert' | 'system_update' | null
alter table public.announcements add column if not exists start_date timestamptz not null default now();
alter table public.announcements add column if not exists end_date timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'announcements_target_audience_check'
  ) then
    alter table public.announcements
      add constraint announcements_target_audience_check
      check (target_audience in ('all', 'release_managers', 'account_owners', 'guardians', 'recipients'));
  end if;
end $$;

create index if not exists announcements_active_idx
  on public.announcements (is_active, target_audience, start_date);

-- Doubles as the "read" tracker: RmNotificationsService.markRead() and
-- .dismiss() both upsert here (see rm-notifications.service.ts) — a dismissed
-- announcement is treated as read, and a read one is treated as dismissed.
-- There is intentionally no separate `is_read` column.
create table if not exists public.announcement_dismissals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  constraint unique_user_announcement unique (user_id, announcement_id)
);

create index if not exists announcement_dismissals_user_idx
  on public.announcement_dismissals (user_id);

alter table public.announcements enable row level security;
alter table public.announcement_dismissals enable row level security;

-- Announcements are system-authored content; every authenticated user may
-- read active ones (the app layer filters by target_audience/date range).
-- Only the service role (used by the backend) may write.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'announcements'
      and policyname = 'Authenticated users can read active announcements'
  ) then
    create policy "Authenticated users can read active announcements"
      on public.announcements for select
      using (auth.role() = 'authenticated');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'announcement_dismissals'
      and policyname = 'Users can manage their own dismissals'
  ) then
    create policy "Users can manage their own dismissals"
      on public.announcement_dismissals for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;
