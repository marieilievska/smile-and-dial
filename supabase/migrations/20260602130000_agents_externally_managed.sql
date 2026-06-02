-- "Connect an existing ElevenLabs agent" support.
--
-- An agent can now be created two ways:
--   * Built in-app (the wizard) — we own its config and push it to ElevenLabs.
--   * Connected by ID — it already exists in ElevenLabs, hand-built there. We
--     only store a reference to it (elevenlabs_agent_id) and must NEVER push
--     config to it, or we'd overwrite the user's prompt/voice with our empty
--     local fields.
--
-- `externally_managed` flags the second kind so the sync layer skips it.

alter table public.agents
  add column if not exists externally_managed boolean not null default false;

comment on column public.agents.externally_managed is
  'True for agents connected by ElevenLabs ID (built outside the app). The '
  'sync layer never pushes config to these — they are reference-only.';
