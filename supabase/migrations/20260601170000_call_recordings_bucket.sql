-- ---------------------------------------------------------------------------
-- Private storage bucket for call recordings.
--
-- The ElevenLabs post-call AUDIO webhook (type=post_call_audio) delivers the
-- full conversation as base64 MP3. We decode it and store it here, then set
-- calls.recording_path to the object path. Served back to operators via a
-- short-lived signed URL.
--
-- Private bucket: objects are only reachable through a signed URL minted
-- server-side, never public. Mirrors the knowledge-base-files bucket pattern.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('call-recordings', 'call-recordings', false)
on conflict (id) do nothing;

-- Authenticated users may read recordings (RLS on the calls table already
-- scopes which calls they can see; the signed URL is minted server-side).
create policy "call_recordings_select"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'call-recordings');

-- Inserts/deletes happen from the post-call webhook under the service role,
-- which bypasses RLS — no authenticated insert policy is granted on purpose,
-- so only the server can write recordings.
