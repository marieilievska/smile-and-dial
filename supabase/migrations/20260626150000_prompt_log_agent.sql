-- Associate each Agent Prompt Log entry with an agent (Reporting follow-on).
alter table public.agent_prompt_log
  add column if not exists agent_id uuid references public.agents (id) on delete set null;

-- The one existing entry is the AI Market Research prompt; tag it.
update public.agent_prompt_log
  set agent_id = (select id from public.agents where name = 'AI Market Research' limit 1)
  where agent_id is null;
