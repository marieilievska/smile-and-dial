-- Notifications + campaign pause metadata.
--
-- 1. `notifications` — generic per-user inbox. The notification bell in the
--    top bar (Section 17 line 1032) will read from here once wired up.
--    Used by the spend cap monitor (Step 25) and later by the Goal Met
--    notifier, the connect-rate monitor (Step 26), and inbound match.
--
-- 2. `campaigns.paused_at` / `paused_reason` — distinguish a manual pause
--    from an auto-pause and capture when it happened. Manual pauses leave
--    paused_reason='manual'; the spend cap monitor sets
--    'daily_spend_cap' or 'monthly_spend_cap'.

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  message text not null,
  ref_table text,
  ref_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.notifications is
  'Per-user notification feed. Surfaced in the top-bar bell once the UI '
  'is wired up; written by background jobs (spend cap monitor, connect '
  'rate monitor, Goal Met notifier).';

create index notifications_user_id_created_at_idx
  on public.notifications (user_id, created_at desc);
create index notifications_user_id_unread_idx
  on public.notifications (user_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- RLS — users see and update only their own notifications.
-- ---------------------------------------------------------------------------
alter table public.notifications enable row level security;

create policy "notifications_select"
  on public.notifications
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Updates limited to read_at — done via dashboard "mark as read" actions.
create policy "notifications_update"
  on public.notifications
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Inserts only via service role (background jobs). No insert policy.

-- ---------------------------------------------------------------------------
-- Campaign pause metadata
-- ---------------------------------------------------------------------------
alter table public.campaigns
  add column paused_at timestamptz,
  add column paused_reason text check (
    paused_reason is null
    or paused_reason in (
      'manual', 'daily_spend_cap', 'monthly_spend_cap', 'auto'
    )
  );

comment on column public.campaigns.paused_at is
  'Set when status flips to paused. Cleared (with paused_reason) when '
  'resumed.';
comment on column public.campaigns.paused_reason is
  'Why the campaign is paused: manual (user clicked Pause), '
  'daily_spend_cap / monthly_spend_cap (spend cap monitor), or auto '
  '(catch-all for other automatic pauses).';
