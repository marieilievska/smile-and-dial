-- Knowledge bases: collections of reference material (files and URLs) that
-- AI agents can draw on. Synced to ElevenLabs in a later phase.
-- See BUILD_PLAN.md Section 3 (knowledge_bases, knowledge_base_sources).

create table public.knowledge_bases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  elevenlabs_kb_id text,
  created_at timestamptz not null default now()
);

comment on table public.knowledge_bases is 'Reference material collections for AI agents.';

create index knowledge_bases_owner_id_idx on public.knowledge_bases (owner_id);

create table public.knowledge_base_sources (
  id uuid primary key default gen_random_uuid(),
  kb_id uuid not null
    references public.knowledge_bases (id) on delete cascade,
  type text not null check (type in ('file', 'url')),
  file_path text,
  url text,
  synced_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.knowledge_base_sources is 'Files and URLs inside a knowledge base.';

create index knowledge_base_sources_kb_id_idx
  on public.knowledge_base_sources (kb_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security: members manage their own knowledge bases; admins all.
-- ---------------------------------------------------------------------------
alter table public.knowledge_bases enable row level security;

create policy "knowledge_bases_select"
  on public.knowledge_bases
  for select
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "knowledge_bases_insert"
  on public.knowledge_bases
  for insert
  to authenticated
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "knowledge_bases_update"
  on public.knowledge_bases
  for update
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  )
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "knowledge_bases_delete"
  on public.knowledge_bases
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

-- Access to a source follows access to its parent knowledge base.
alter table public.knowledge_base_sources enable row level security;

create policy "knowledge_base_sources_all"
  on public.knowledge_base_sources
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.knowledge_bases
      where knowledge_bases.id = knowledge_base_sources.kb_id
        and (
          knowledge_bases.owner_id = (select auth.uid())
          or public.is_admin((select auth.uid()))
        )
    )
  )
  with check (
    exists (
      select 1
      from public.knowledge_bases
      where knowledge_bases.id = knowledge_base_sources.kb_id
        and (
          knowledge_bases.owner_id = (select auth.uid())
          or public.is_admin((select auth.uid()))
        )
    )
  );

-- ---------------------------------------------------------------------------
-- Private storage bucket for uploaded knowledge-base files.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('knowledge-base-files', 'knowledge-base-files', false)
on conflict (id) do nothing;

create policy "kb_files_insert"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'knowledge-base-files');

create policy "kb_files_select"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'knowledge-base-files');

create policy "kb_files_delete"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'knowledge-base-files');
