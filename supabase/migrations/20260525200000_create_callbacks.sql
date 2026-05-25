-- Callbacks: scheduled redials. See BUILD_PLAN.md Section 3 (callbacks),
-- Section 8 (callback outcome flow), and Section 11 (dial-time enforcement).
--
-- One callback row per scheduled redial. Created either:
--   * automatically by the agent (when a call's outcome is `callback`,
--     created_by stays null), or
--   * manually by a user from the lead detail modal (created_by = uid).
--
-- The dialer's queue (`dial_queue` view, Step 21a) treats a lead whose
-- status is `callback` as due to dial when its next_call_at <= now(). The
-- retry engine (Step 24) is what bumps next_call_at to the callback's
-- scheduled_at — this migration only creates the callback shape.

create table public.callbacks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete restrict,
  originating_call_id uuid references public.calls (id) on delete set null,
  scheduled_at timestamptz not null,
  status text not null default 'pending' check (
    status in ('pending', 'completed', 'missed', 'cancelled')
  ),
  -- Null when the callback was auto-created by an agent during a call.
  created_by uuid references auth.users (id) on delete set null,
  -- FK to the call that fulfilled this callback (set when that call runs).
  result_call_id uuid references public.calls (id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.callbacks is
  'Scheduled redials. Auto-created by agents (created_by null) or manually '
  'by users from the lead modal.';

create index callbacks_lead_id_idx on public.callbacks (lead_id);
create index callbacks_campaign_id_idx on public.callbacks (campaign_id);
create index callbacks_scheduled_at_idx on public.callbacks (scheduled_at);
create index callbacks_status_idx on public.callbacks (status);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
alter table public.callbacks enable row level security;

-- Members see callbacks for leads they own; admins see all.
create policy "callbacks_select"
  on public.callbacks
  for select
  to authenticated
  using (
    public.is_admin((select auth.uid()))
    or exists (
      select 1 from public.leads l
      where l.id = callbacks.lead_id
        and l.owner_id = (select auth.uid())
    )
  );

-- Same scope for insert/update: a member can only manage callbacks for
-- their own leads. Auto-creation from the post-call webhook runs via the
-- service role, which bypasses RLS.
create policy "callbacks_insert"
  on public.callbacks
  for insert
  to authenticated
  with check (
    public.is_admin((select auth.uid()))
    or exists (
      select 1 from public.leads l
      where l.id = lead_id
        and l.owner_id = (select auth.uid())
    )
  );

create policy "callbacks_update"
  on public.callbacks
  for update
  to authenticated
  using (
    public.is_admin((select auth.uid()))
    or exists (
      select 1 from public.leads l
      where l.id = callbacks.lead_id
        and l.owner_id = (select auth.uid())
    )
  )
  with check (
    public.is_admin((select auth.uid()))
    or exists (
      select 1 from public.leads l
      where l.id = callbacks.lead_id
        and l.owner_id = (select auth.uid())
    )
  );

-- No delete policy — cancel by setting status='cancelled' instead, so the
-- audit trail of who scheduled what stays intact.
