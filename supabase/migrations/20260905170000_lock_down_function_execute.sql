-- ---------------------------------------------------------------------------
-- Lock down EXECUTE on every function in schema public.
--
-- Problem (verified live 2026-09-05): Postgres grants EXECUTE on every new
-- function to PUBLIC, and Supabase's default privileges add anon /
-- authenticated / service_role on top. Only merge_campaign was ever revoked
-- (20260812120000). So with nothing but the public anon key and no login,
-- POST /rest/v1/rpc/is_phone_on_dnc, pool_number_usage_24h,
-- elevenlabs_voice_ids and is_admin all returned data, and the SECURITY
-- DEFINER mutators (expire_resting_leads, merge_inbound_lead,
-- monitor_campaign_spend_caps, monitor_twilio_connect_rates,
-- refresh_cost_rollup, refresh_smart_list, refresh_twilio_number_daily_stats,
-- get_or_create_inbound_list, bump_api_rate_limit, pre_call_check) were
-- callable too. merge_inbound_lead also skipped its ownership check whenever
-- in_actor was null.
--
-- Fix, in order:
--   1. Revoke EXECUTE on ALL functions in public from PUBLIC, anon and
--      authenticated. service_role is left alone (the dialer tick, the
--      webhooks, the cron endpoints and the tests all run as service_role and
--      are trusted by construction) and re-granted explicitly as a safety net.
--   2. Revoke the DEFAULT privileges so functions created by FUTURE migrations
--      start closed instead of open.
--   3. Re-grant to authenticated ONLY the functions the app calls with the
--      user-scoped (cookie / RLS) Supabase client, plus the helpers those need
--      to run. The call-site evidence sits next to each grant.
--   4. Redefine merge_inbound_lead so a user-scoped call is authorised by
--      auth.uid() (owner or admin) and the audit row records auth.uid(),
--      while an internal service_role call keeps trusting in_actor.
--
-- REMINDER FOR EVERY FUTURE MIGRATION THAT CREATES A FUNCTION: after this
-- migration a new function is executable by postgres and service_role only.
-- If the app must call it with the cookie client, add an explicit
--   grant execute on function public.<name>(<arg types>) to authenticated;
-- with a comment naming the call site. Never grant to anon or PUBLIC. If the
-- function is SECURITY INVOKER and calls other public.* functions, the caller
-- needs EXECUTE on those too. tests/function-privileges.unit.test.ts asserts
-- the allow-list below and fails on any later grant to anon / PUBLIC.
-- ---------------------------------------------------------------------------

-- 1. Close everything for the untrusted roles. anon gets its own line so the
--    intent "anon executes nothing" is explicit, not implied by PUBLIC.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema public from anon;

-- service_role: every function it needs today carries an explicit
-- service_role=X entry from Supabase's default privileges, but a function
-- whose ACL was never materialised (only the implicit PUBLIC grant) would have
-- just been locked away from the dialer. Re-grant so that cannot happen.
grant execute on all functions in schema public to service_role;

-- 2. Future functions start closed. `supabase db push` and the dashboard SQL
--    editor both run as `postgres`, which is therefore the owning role whose
--    defaults matter. Supabase seeds
--      alter default privileges for role postgres in schema public
--        grant execute on functions to anon, authenticated, service_role;
--    and Postgres itself seeds EXECUTE for PUBLIC. Undo both for PUBLIC /
--    anon / authenticated; service_role keeps its default.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- 3. The auth.users trigger. handle_new_user() fires when Supabase Auth
--    (running as supabase_auth_admin) inserts a user. Postgres checks EXECUTE
--    on a trigger function at CREATE TRIGGER time, not at fire time, so this
--    is belt-and-braces -- kept so sign-ups can never trip on the revoke.
--    Guarded so the migration still applies on a database without the role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function public.handle_new_user() to supabase_auth_admin';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. merge_inbound_lead v3: authorise by auth.uid().
--
-- Body copied verbatim from 20260902210000 (v2, keep the caller's number +
-- carry the whole history). ONLY the "Ownership + caller checks" block and
-- the audit actor change:
--   * auth.uid() set (cookie client): the caller must own the source lead or
--     be an admin, and the audit row records auth.uid() whatever in_actor
--     says -- a user can no longer name someone else as the actor.
--   * auth.uid() null (service_role / internal SQL): trust in_actor as
--     before, with the same owner-or-admin check.
--   * Neither: refuse. v2 silently skipped the ownership check here.
-- Signature unchanged so src/lib/leads/lead-actions.ts keeps working.
-- ---------------------------------------------------------------------------
create or replace function public.merge_inbound_lead(
  in_source_lead_id uuid,
  in_destination_lead_id uuid,
  in_patch jsonb,
  in_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.leads%rowtype;
  v_dest public.leads%rowtype;
  v_source_inbound boolean;
  v_phone text;
  v_phone_slot text := null;
  v_summary record;
  v_earliest_cb timestamptz;
  v_new_status text := null;
  v_actor uuid;
begin
  if in_source_lead_id = in_destination_lead_id then
    raise exception 'source and destination must differ';
  end if;

  -- Lock both rows for the duration of the transaction so a concurrent
  -- merge / edit can't race us.
  select * into v_source from public.leads
   where id = in_source_lead_id and deleted_at is null
   for update;
  if not found then
    raise exception 'source lead not found';
  end if;

  select * into v_dest from public.leads
   where id = in_destination_lead_id and deleted_at is null
   for update;
  if not found then
    raise exception 'destination lead not found';
  end if;

  -- Ownership + caller checks (defense in depth over the action's RLS reads).
  if v_source.owner_id is distinct from v_dest.owner_id then
    raise exception 'leads have different owners';
  end if;

  -- Who is acting? A user-scoped call carries auth.uid() and that wins over
  -- in_actor; an internal (service_role) call has no auth.uid() and must say
  -- who it acts for. Either way the actor must own the leads or be an admin.
  v_actor := auth.uid();
  if v_actor is null then
    v_actor := in_actor;
  end if;
  if v_actor is null then
    raise exception 'merge_inbound_lead requires an authenticated caller or an explicit in_actor';
  end if;
  if v_source.owner_id is distinct from v_actor and not public.is_admin(v_actor) then
    raise exception 'caller does not own these leads';
  end if;

  -- Source must be an auto-created inbound lead.
  select coalesce(l.is_inbound_default, false) into v_source_inbound
    from public.lists l
   where l.id = v_source.list_id;
  if not coalesce(v_source_inbound, false) then
    raise exception 'only inbound leads can be merged';
  end if;

  -- 1. Patch the destination with the caller-computed field set (already
  --    filtered to "fill only where destination is empty" in the action).
  if in_patch is not null and in_patch <> '{}'::jsonb then
    update public.leads
       set company         = coalesce((in_patch->>'company'), company),
           business_email   = coalesce((in_patch->>'business_email'), business_email),
           owner_name       = coalesce((in_patch->>'owner_name'), owner_name),
           owner_phone      = coalesce((in_patch->>'owner_phone'), owner_phone),
           manager_name     = coalesce((in_patch->>'manager_name'), manager_name),
           employee_name    = coalesce((in_patch->>'employee_name'), employee_name),
           website          = coalesce((in_patch->>'website'), website),
           category         = coalesce((in_patch->>'category'), category),
           city             = coalesce((in_patch->>'city'), city),
           state            = coalesce((in_patch->>'state'), state),
           google_place_id  = coalesce((in_patch->>'google_place_id'), google_place_id)
     where id = in_destination_lead_id;
    -- Re-read so the phone-slot logic below sees the patched row.
    select * into v_dest from public.leads where id = in_destination_lead_id;
  end if;

  -- 2. Keep the number the caller used. The source's business_phone IS the
  --    caller ID of the inbound call. Store it on the destination in the first
  --    empty phone slot so the next call from it matches this lead directly.
  v_phone := nullif(trim(v_source.business_phone), '');
  if v_phone is not null
     and v_phone is distinct from v_dest.business_phone
     and v_phone is distinct from v_dest.mobile_phone
     and v_phone is distinct from v_dest.owner_phone then
    if v_dest.mobile_phone is null or v_dest.mobile_phone = '' then
      update public.leads set mobile_phone = v_phone where id = in_destination_lead_id;
      v_phone_slot := 'mobile_phone';
    elsif v_dest.owner_phone is null or v_dest.owner_phone = '' then
      update public.leads set owner_phone = v_phone where id = in_destination_lead_id;
      v_phone_slot := 'owner_phone';
    else
      v_phone_slot := 'audit_only';
    end if;
  elsif v_phone is not null then
    v_phone_slot := 'already_present';
  end if;

  -- 3. Repoint history to the destination.
  update public.calls     set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;
  update public.callbacks set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;
  update public.texts     set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;
  update public.emails    set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;
  update public.short_links     set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;
  update public.calendly_events set lead_id = in_destination_lead_id where lead_id = in_source_lead_id;

  -- Per-campaign rolling summaries: move when the destination has none for
  -- that campaign, otherwise append the source's text to the destination's.
  for v_summary in
    select id, campaign_id, ai_summary
      from public.lead_campaign_summaries
     where lead_id = in_source_lead_id
  loop
    if exists (
      select 1 from public.lead_campaign_summaries
       where lead_id = in_destination_lead_id and campaign_id = v_summary.campaign_id
    ) then
      if nullif(trim(v_summary.ai_summary), '') is not null then
        update public.lead_campaign_summaries
           set ai_summary = case
                 when nullif(trim(ai_summary), '') is null then v_summary.ai_summary
                 else ai_summary || E'\n\n' || v_summary.ai_summary
               end,
               updated_at = now()
         where lead_id = in_destination_lead_id and campaign_id = v_summary.campaign_id;
      end if;
      delete from public.lead_campaign_summaries where id = v_summary.id;
    else
      update public.lead_campaign_summaries
         set lead_id = in_destination_lead_id
       where id = v_summary.id;
    end if;
  end loop;

  -- Custom-field values: fill what the destination lacks, drop the rest.
  update public.lead_custom_values s
     set lead_id = in_destination_lead_id
   where s.lead_id = in_source_lead_id
     and not exists (
       select 1 from public.lead_custom_values d
        where d.lead_id = in_destination_lead_id
          and d.custom_field_id = s.custom_field_id
     );
  delete from public.lead_custom_values where lead_id = in_source_lead_id;

  -- Smart-list membership is recomputed by the smart-list job; the source is
  -- going away, so just drop its rows.
  delete from public.smart_list_members where lead_id = in_source_lead_id;

  -- 4. Carry state forward onto the destination.
  update public.leads
     set conversations = conversations + coalesce(v_source.conversations, 0),
         last_call_at  = greatest(coalesce(last_call_at, v_source.last_call_at),
                                  coalesce(v_source.last_call_at, last_call_at)),
         decision_maker_reached = decision_maker_reached or coalesce(v_source.decision_maker_reached, false),
         updated_at = now()
   where id = in_destination_lead_id;

  -- Terminal states win: a booked or DNC'd caller stays booked / DNC'd.
  if v_source.status in ('goal_met', 'dnc') and v_dest.status not in ('goal_met', 'dnc') then
    v_new_status := v_source.status;
    update public.leads
       set status = v_new_status, next_call_at = null
     where id = in_destination_lead_id;
  end if;

  -- A pending callback (now on the destination) parks it, unless terminal.
  if v_new_status is null and v_dest.status not in ('goal_met', 'dnc') then
    select min(scheduled_at) into v_earliest_cb
      from public.callbacks
     where lead_id = in_destination_lead_id and status = 'pending';
    if v_earliest_cb is not null then
      v_new_status := 'callback';
      update public.leads
         set status = 'callback', next_call_at = v_earliest_cb
       where id = in_destination_lead_id;
    end if;
  end if;

  -- 5. Soft-delete the source.
  update public.leads
     set deleted_at = now()
   where id = in_source_lead_id;

  -- 6. Audit. v_actor is auth.uid() for a user-scoped call, in_actor otherwise.
  insert into public.system_events (kind, actor_user_id, ref_table, ref_id, payload)
  values (
    'lead_merged',
    v_actor,
    'leads',
    in_destination_lead_id,
    jsonb_build_object(
      'from', in_source_lead_id,
      'to', in_destination_lead_id,
      'merged_phone', v_phone,
      'phone_stored_in', v_phone_slot,
      'status_carried', v_new_status
    )
  );
end;
$$;

comment on function public.merge_inbound_lead is
  'Atomically merge an inbound lead into a destination: patch empty fields, '
  'keep the caller''s number (mobile_phone/owner_phone), repoint calls, '
  'callbacks, summaries, custom values, texts, emails, links, bookings, carry '
  'callback/goal_met/dnc status, soft-delete the source, write the audit row. '
  'Authorised by auth.uid() (owner or admin) when called by a user; an internal '
  'service_role call must pass in_actor.';

-- ---------------------------------------------------------------------------
-- 5. The authenticated allow-list. Each grant names the call site that uses
--    the cookie / RLS client (src/lib/supabase/server.ts createClient). Every
--    other function is reached only through the service-role client and
--    stays closed to authenticated.
-- ---------------------------------------------------------------------------

-- is_admin(uuid): evaluated inside almost every RLS policy as the calling
-- role, e.g. leads: `owner_id = auth.uid() or public.is_admin(auth.uid())`.
-- Without it every authenticated table read fails with "permission denied".
grant execute on function public.is_admin(uuid) to authenticated;

-- leads_matching_filter_rows(jsonb): src/app/(app)/leads/leads-query.ts:87,
-- :171, :178 -- the leads page, lead detail siblings and export, all through
-- the cookie client. SECURITY INVOKER, so leads RLS applies.
grant execute on function public.leads_matching_filter_rows(jsonb) to authenticated;

-- leads_matching_filter(jsonb): src/lib/smart-lists/resolve.ts:32, called
-- from src/lib/campaigns/audience-actions.ts:78 with the cookie client
-- (audience preview). SECURITY INVOKER.
grant execute on function public.leads_matching_filter(jsonb) to authenticated;

-- _smart_list_*_sql: the recipe-to-SQL helpers that both SECURITY INVOKER
-- filter functions above call (20260619151000 lines 193-260,
-- 20260810120000:25). An invoker function runs as its caller, so the caller
-- needs EXECUTE on these too. They only build predicate text.
grant execute on function public._smart_list_node_sql(jsonb) to authenticated;
grant execute on function public._smart_list_custom_sql(text, text, jsonb) to authenticated;
grant execute on function public._smart_list_date_sql(text, text, jsonb) to authenticated;
grant execute on function public._smart_list_num_sql(text, text, jsonb) to authenticated;
grant execute on function public._smart_list_text_sql(text, text, jsonb) to authenticated;

-- cohort_rows(date, date): src/lib/cohorts/data.ts:52 (Reporting > Cohorts,
-- cookie client so members see only their own rows). SECURITY INVOKER; it
-- calls no other public.* function.
grant execute on function public.cohort_rows(date, date) to authenticated;

-- pre_call_check(uuid, uuid): src/lib/dialer/call-now.ts:147 (Call Now,
-- `userClient`). SECURITY DEFINER, so its own calls to
-- is_within_calling_hours / pool_number_usage_24h run as the owner and need
-- no grant of their own. (src/lib/dialer/queue.ts:111 also calls it with the
-- cookie client, but that helper has no callers.)
grant execute on function public.pre_call_check(uuid, uuid) to authenticated;

-- is_phone_on_dnc(text): src/lib/dialer/call-now.ts:172 (`userClient`; the
-- owner-phone DNC check before a manual dial). Returns only a boolean.
grant execute on function public.is_phone_on_dnc(text) to authenticated;

-- refresh_smart_list(uuid): src/lib/campaigns/actions.ts:203 (cookie client;
-- rebuilds a freshly attached smart list inline). The cron path
-- (src/lib/smart-lists/cache.ts:40) uses service_role and keeps its grant.
grant execute on function public.refresh_smart_list(uuid) to authenticated;

-- merge_inbound_lead(uuid, uuid, jsonb, uuid): src/lib/leads/lead-actions.ts:345
-- (cookie client). Authorises by auth.uid() -- see the redefinition above.
grant execute on function public.merge_inbound_lead(uuid, uuid, jsonb, uuid) to authenticated;

-- set_updated_at(): BEFORE UPDATE trigger on leads and two other tables,
-- fired by authenticated updates. Like handle_new_user this is checked at
-- CREATE TRIGGER time rather than fire time -- kept as belt-and-braces so an
-- ordinary lead edit can never trip on this migration.
grant execute on function public.set_updated_at() to authenticated;

-- NOT granted, on purpose (service_role only):
--   bump_api_rate_limit        src/app/api/v1/leads/route.ts:66
--   claim_lead_for_dial        src/lib/dialer/tick.ts:238
--   elevenlabs_voice_ids       no caller in src/
--   expire_resting_leads       tests only (admin client)
--   get_or_create_inbound_list src/lib/elevenlabs/inbound-call.ts:123,
--                              src/lib/twilio/inbound-webhook.ts:157
--   is_within_calling_hours    dial_queue view (read by the tick, service_role)
--                              + pre_call_check body (definer)
--   j_num                      refresh_cost_rollup body (definer)
--   merge_campaign             src/lib/campaigns/actions.ts:556 (admin)
--   monitor_*, refresh_cost_rollup, refresh_twilio_number_daily_stats
--                              pg_cron jobs, which run as postgres (owner)
--   pool_number_usage_24h      src/lib/dialer/number-pool.ts:199 (admin)
