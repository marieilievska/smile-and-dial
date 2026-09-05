-- Ledger of AI spend that had no home.
--
-- Five OpenAI callers recorded nothing anywhere: the Ask Smile assistant,
-- the agent drafter, the template splitter and the script tidier (all
-- gpt-5.4), and the demo_front_desk live research (gpt-5.4-mini + web_search,
-- mid-call). ElevenLabs Test Calls (browser sessions from the campaign's Test
-- Call tab) bill credits like any call, but the post-call webhook resolves
-- them as `unknown_conversation` and dropped the cost. None of it reached the
-- Costs page.
--
-- Same shape and access rules as lookup_charges: one row per charge, owner
-- sees their own, admins see all, and only the service role writes (the
-- recorders run inside server actions / webhooks with the service key). The
-- live research ALSO adds its cost to the call's cost_breakdown.openai; the
-- ledger row carries ref_table='calls' so the two can be reconciled.

create table public.ai_charges (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  -- ask_smile | draft_agent | split_agent_template | tidy_prose |
  -- business_research | elevenlabs_test_call (free text: new kinds need no
  -- schema change; the Costs page labels the ones it knows).
  kind text not null,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost numeric not null check (cost >= 0),
  ref_table text,
  ref_id uuid,
  -- Anything useful for reconciliation: conversation_id, credits, web-search
  -- call count, whether research found the business …
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.ai_charges is
  'AI spend outside a call''s cost_breakdown (Ask Smile, agent drafting, '
  'template splitting, script tidying, live business research, ElevenLabs '
  'test calls). Folded into the Costs page OpenAI line and total.';

create index ai_charges_created_idx on public.ai_charges (created_at);
create index ai_charges_owner_idx on public.ai_charges (owner_id);
create index ai_charges_kind_idx on public.ai_charges (kind);

alter table public.ai_charges enable row level security;

create policy "ai_charges_select"
  on public.ai_charges
  for select
  to authenticated
  using (
    public.is_admin((select auth.uid()))
    or owner_id = (select auth.uid())
  );

-- No insert/update/delete policies: service-role writes only.
