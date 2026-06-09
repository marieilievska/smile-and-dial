-- Tag each call as placed by the AI agent or a human, and record who placed a
-- human call. AI calls keep the default so existing rows need no backfill.
alter table public.calls
  add column if not exists call_mode text not null default 'ai'
    check (call_mode in ('ai', 'human')),
  add column if not exists placed_by uuid references public.profiles(id);

comment on column public.calls.call_mode is
  'ai = placed by the autopilot/agent; human = placed by a user via browser calling.';
comment on column public.calls.placed_by is
  'The user who placed a human call (null for AI calls).';

create index if not exists calls_call_mode_idx on public.calls (call_mode);
