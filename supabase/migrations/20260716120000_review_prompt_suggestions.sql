-- Prompt improvement suggestions: human-approved call-review findings feed an
-- on-demand, AI-drafted, anchored edit to the agent's system prompt. A human
-- reviews the exact diff before anything is applied to the live agent.

-- 1. The suggestions themselves. based_on_prompt is the exact live prompt the
--    edits were drafted against (also the freshness-check baseline and the
--    revert target); proposed_prompt is that prompt with the edits applied.
create table if not exists public.review_prompt_suggestions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  flag_key text not null references public.review_flag_defs(key),
  based_on_prompt text not null,
  proposed_prompt text not null,
  -- [{type: 'replace'|'insert_after'|'append', anchor: text, text: text}]
  edits jsonb not null,
  rationale text not null,
  summary text not null,
  example_count int not null default 0,
  status text not null default 'proposed', -- proposed | applied | dismissed | reverted
  model text,
  cost numeric not null default 0,
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  applied_at timestamptz,
  reverted_at timestamptz
);

create index if not exists review_prompt_suggestions_status_idx
  on public.review_prompt_suggestions (status, created_at desc);

alter table public.review_prompt_suggestions enable row level security;

-- Admin-only read via RLS; writes go through service-role server actions
-- (matching call_reviews / agent_prompt_log).
create policy "review_prompt_suggestions_admin_all"
  on public.review_prompt_suggestions
  for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

-- 2. Record WHO curated a flag and WHEN (the AI also writes status='confirmed',
--    so status alone can't tell a human decision apart), plus which suggestion
--    consumed the flag as an example (so one example never feeds two
--    suggestions; cleared when that suggestion is dismissed or reverted).
alter table public.call_review_flags
  add column if not exists curated_by uuid references public.profiles(id) on delete set null,
  add column if not exists curated_at timestamptz,
  add column if not exists suggestion_id uuid references public.review_prompt_suggestions(id) on delete set null;

-- The "available approved examples" pool is always queried with exactly this
-- shape: confirmed + human-curated + not yet consumed.
create index if not exists call_review_flags_suggest_idx
  on public.call_review_flags (flag_key, status)
  where curated_at is not null and suggestion_id is null;
