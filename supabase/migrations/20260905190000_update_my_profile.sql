-- Members could not save their own profile preferences.
--
-- profiles_update (20260521004545) is admin-only, so for a member
-- setActiveCampaign (src/lib/active-campaign/actions.ts), markWelcomeSeen and
-- dismissOnboarding (src/lib/onboarding/actions.ts) matched zero rows and
-- reported success: the active-campaign chip never stuck and the welcome
-- primer came back on every visit.
--
-- Fix: a SECURITY DEFINER function that updates ONLY the caller's own row and
-- ONLY the self-service columns. `role` and `active` are deliberately not
-- reachable from here, so the admin-only UPDATE policy on the table can stay
-- exactly as it is. Unknown keys in the patch are ignored.
--
-- Returns the number of rows updated (0 or 1) so the actions can tell a
-- silent no-op from a save.

create or replace function public.update_my_profile(patch jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_campaign uuid;
  v_rows integer;
begin
  if v_uid is null then
    raise exception 'update_my_profile requires an authenticated caller';
  end if;
  if patch is null or jsonb_typeof(patch) <> 'object' then
    raise exception 'update_my_profile expects a JSON object';
  end if;

  -- The active campaign must be one the caller can actually see (their own,
  -- or any when admin). The action checks this through RLS first; this is the
  -- defense-in-depth copy, since the function itself bypasses RLS.
  if patch ? 'active_campaign_id' then
    v_campaign := nullif(patch ->> 'active_campaign_id', '')::uuid;
    if v_campaign is not null and not exists (
      select 1 from public.campaigns c
       where c.id = v_campaign
         and (c.owner_id = v_uid or public.is_admin(v_uid))
    ) then
      raise exception 'campaign not found or not visible to the caller';
    end if;
  end if;

  update public.profiles
     set active_campaign_id = case
           when patch ? 'active_campaign_id' then v_campaign
           else active_campaign_id
         end,
         welcome_seen_at = case
           when patch ? 'welcome_seen_at'
             then (patch ->> 'welcome_seen_at')::timestamptz
           else welcome_seen_at
         end,
         onboarding_dismissed_at = case
           when patch ? 'onboarding_dismissed_at'
             then (patch ->> 'onboarding_dismissed_at')::timestamptz
           else onboarding_dismissed_at
         end,
         full_name = case
           when patch ? 'full_name' then nullif(trim(patch ->> 'full_name'), '')
           else full_name
         end
   where id = v_uid;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.update_my_profile(jsonb) is
  'Self-service profile update: patches ONLY the caller''s row (auth.uid()) and '
  'ONLY active_campaign_id / welcome_seen_at / onboarding_dismissed_at / '
  'full_name. role and active are never touched. Returns rows updated (0 or 1).';

-- Called with the cookie client from src/lib/active-campaign/actions.ts
-- (setActiveCampaign) and src/lib/onboarding/actions.ts (markWelcomeSeen,
-- dismissOnboarding). Never anon: auth.uid() is null there and the function
-- refuses, but the grant must not exist either (see 20260905170000).
revoke execute on function public.update_my_profile(jsonb) from public, anon;
grant execute on function public.update_my_profile(jsonb) to authenticated;
