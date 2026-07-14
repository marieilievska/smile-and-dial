-- Tighten storage access: admins see everything, members only their own.
--
-- The call-recordings and knowledge-base-files buckets were readable (and KB
-- files writable/deletable) by ANY authenticated user, because the policies
-- checked only the bucket name. Today only the admin logs in, so the practical
-- blast radius is nil — but the schema has a `member` role, and the moment a
-- non-admin is added this is a cross-user leak of call audio + customer PII and
-- a tamper/delete vector on other people's KB files.
--
-- Each policy is scoped to the owner; admins bypass via is_admin(). The app's
-- own recording playback mints signed URLs under the SERVICE role (which
-- bypasses RLS), and KB upload/remove run as the owner against their own KB, so
-- this does not change any in-app behavior — it only closes direct Storage-API
-- access by a would-be non-owner.

-- ---------------------------------------------------------------------------
-- call-recordings: SELECT scoped to the owner of the call's lead.
-- Inserts/deletes stay service-role-only (no authenticated policy exists), so
-- only the SELECT policy is replaced. Object name == calls.recording_path for
-- rows stored in this bucket (legacy/human http(s) URLs simply never match).
-- ---------------------------------------------------------------------------
drop policy if exists "call_recordings_select" on storage.objects;
create policy "call_recordings_select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'call-recordings'
    and (
      public.is_admin((select auth.uid()))
      or exists (
        select 1
        from public.calls c
        join public.leads l on l.id = c.lead_id
        where c.recording_path = storage.objects.name
          and l.owner_id = (select auth.uid())
      )
    )
  );

-- ---------------------------------------------------------------------------
-- knowledge-base-files: scope to the owner of the KB named in the path prefix.
-- Upload path is "<kb_id>/<uuid>/<filename>", so the first folder segment is
-- the knowledge_base id. A member may only read/write/delete files under a KB
-- they own; admins may touch all. INSERT keys off the prefix (the row in
-- knowledge_base_sources doesn't exist yet at upload time).
-- ---------------------------------------------------------------------------
drop policy if exists "kb_files_select" on storage.objects;
create policy "kb_files_select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'knowledge-base-files'
    and (
      public.is_admin((select auth.uid()))
      or exists (
        select 1 from public.knowledge_bases kb
        where kb.id::text = split_part(storage.objects.name, '/', 1)
          and kb.owner_id = (select auth.uid())
      )
    )
  );

drop policy if exists "kb_files_insert" on storage.objects;
create policy "kb_files_insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'knowledge-base-files'
    and (
      public.is_admin((select auth.uid()))
      or exists (
        select 1 from public.knowledge_bases kb
        where kb.id::text = split_part(storage.objects.name, '/', 1)
          and kb.owner_id = (select auth.uid())
      )
    )
  );

drop policy if exists "kb_files_delete" on storage.objects;
create policy "kb_files_delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'knowledge-base-files'
    and (
      public.is_admin((select auth.uid()))
      or exists (
        select 1 from public.knowledge_bases kb
        where kb.id::text = split_part(storage.objects.name, '/', 1)
          and kb.owner_id = (select auth.uid())
      )
    )
  );
