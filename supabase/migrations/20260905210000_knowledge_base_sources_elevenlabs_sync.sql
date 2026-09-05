-- ---------------------------------------------------------------------------
-- Knowledge-base sources: per-source ElevenLabs sync bookkeeping.
--
-- Until now nothing ever uploaded a knowledge-base source to ElevenLabs or
-- attached it to an agent — knowledge_base_sources.synced_at was never
-- written and knowledge_bases.elevenlabs_kb_id never held anything. So an
-- agent with a knowledge base "attached" in the wizard drew on nothing.
--
-- ElevenLabs has no knowledge-base CONTAINER object: each file / URL becomes
-- its own document (POST /v1/convai/knowledge-base/{file,url} → { id }), and
-- an agent references documents one by one in
-- conversation_config.agent.prompt.knowledge_base[]. The natural unit of
-- sync is therefore the SOURCE, not the knowledge base:
--
--   elevenlabs_document_id  the document id ElevenLabs returned; null until
--                           the first successful upload
--   synced_at               (existing column) when that upload succeeded
--   sync_error              why the last upload attempt failed; cleared on
--                           success. Drives the "Sync failed — retry" state.
--
-- knowledge_bases.elevenlabs_kb_id stays in place but is deliberately UNUSED
-- (there is nothing on the ElevenLabs side for it to point at).
--
-- No functions are created here, so nothing needs an EXECUTE grant.
-- ---------------------------------------------------------------------------

alter table public.knowledge_base_sources
  add column if not exists elevenlabs_document_id text,
  add column if not exists sync_error text;

comment on column public.knowledge_base_sources.elevenlabs_document_id is
  'ElevenLabs knowledge-base document id for this source (per-source; ElevenLabs has no KB container). Null until the first successful upload.';
comment on column public.knowledge_base_sources.synced_at is
  'When the source was last successfully uploaded to ElevenLabs.';
comment on column public.knowledge_base_sources.sync_error is
  'Why the last ElevenLabs upload failed; null after a successful sync.';
comment on column public.knowledge_bases.elevenlabs_kb_id is
  'UNUSED. ElevenLabs tracks documents, not knowledge bases; see knowledge_base_sources.elevenlabs_document_id.';
