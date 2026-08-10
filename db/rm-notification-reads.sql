-- Read/unread tracking for the RM notification bell (rm-notifications.service.ts).
-- Notifications shown there are a merge of `announcements` rows and
-- `activity_log` events — the latter have no row in `announcements`, so this
-- table tracks read state by a bare notification id with no FK to either
-- source table. Notifications are never deleted, only toggled read/unread.
create table if not exists public.rm_notification_reads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  notification_id uuid not null,
  is_read boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unique_user_notification unique (user_id, notification_id)
);

create index if not exists rm_notification_reads_user_idx
  on public.rm_notification_reads (user_id);

alter table public.rm_notification_reads enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'rm_notification_reads'
      and policyname = 'Users can manage their own notification read state'
  ) then
    create policy "Users can manage their own notification read state"
      on public.rm_notification_reads for all
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;
end $$;
