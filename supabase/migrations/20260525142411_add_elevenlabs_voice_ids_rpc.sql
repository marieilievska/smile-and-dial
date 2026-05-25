-- The agent wizard's voice picker needs to read elevenlabs_voice_ids, but
-- the app_settings table stays admin-only (it also holds the API key).
-- Expose just the voice ids through a security-definer function so members
-- building agents can populate the dropdown.

create or replace function public.elevenlabs_voice_ids()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select elevenlabs_voice_ids from public.app_settings where id = 1;
$$;

grant execute on function public.elevenlabs_voice_ids() to authenticated;
