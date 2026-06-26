-- Hot Leads is now a live list of a campaign's "warm" calls (Reporting Phase 3).
-- Deleting one permanently hides that call from the list — recorded here. The old
-- seeded public.hot_leads table is left in place (unused) and not dropped.
create table if not exists public.hot_lead_dismissals (
  call_id uuid primary key references public.calls (id) on delete cascade,
  dismissed_by uuid references auth.users (id),
  dismissed_at timestamptz not null default now()
);
alter table public.hot_lead_dismissals enable row level security;
-- Admin-only read; writes go through a service-role server action with an in-code
-- admin check, mirroring the other Agent Analytics tables.
create policy "admins read hot_lead_dismissals"
  on public.hot_lead_dismissals for select
  using (public.is_admin((select auth.uid())));
