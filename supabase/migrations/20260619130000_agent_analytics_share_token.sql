-- Secret token gating the public Market Research share page
-- (/share/agent-analytics/<token>). Additive, nullable column on the
-- app_settings singleton — same pattern as the other out-of-band secrets.
alter table public.app_settings
  add column if not exists agent_analytics_share_token text;

comment on column public.app_settings.agent_analytics_share_token is
  'Unguessable token in the public Agent Analytics share URL. Rotate or clear '
  'this value to revoke the link. Set out-of-band, never committed.';
