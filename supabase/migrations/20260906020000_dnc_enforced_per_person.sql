-- ---------------------------------------------------------------------------
-- Do-not-call is enforced PER PERSON, not workspace-wide.
--
-- WHY THIS LOOKS WRONG AND IS NOT. READ BEFORE "FIXING" IT.
--
-- Product decision (owner, 2026-09-06), made with the consequence spelled out
-- and accepted: the do-not-call list is private per person AND enforced per
-- person. A number one user has suppressed must STILL be dialable by another
-- user. Stated back to her and confirmed: "a business that tells one teammate
-- to stop can still be called by a different teammate from the same company."
-- That is the intended behaviour, not an oversight.
--
-- 20260905192000 made the LIST per user (owner_id + fill trigger + per-user
-- RLS) but deliberately left ENFORCEMENT workspace-wide, and said so in three
-- places ("Do not add an owner filter there"). 20260905241000 repeated it.
-- This migration reverses that half of the decision on purpose. Every comment
-- those two migrations left behind is superseded by this file; the table and
-- column comments they set are rewritten at the bottom.
--
-- Consequences, for the record:
--   * Alice suppressing +1555… blocks Alice's leads only. Bob's lead with the
--     same phone keeps dialing.
--   * "Already on the DNC list" has meant THEIR list since 20260905241000;
--     now it means their dialing too.
--   * dnc_entries.owner_id is `on delete set null`, so deleting a user
--     orphans their rows and those block nobody. Their leads are gone with
--     them (leads.owner_id is `on delete cascade`), so nothing they had
--     suppressed becomes dialable to them; another user's identical number
--     was already dialable under this rule. Matching stays strict — no
--     `or d.owner_id is null` branch — so the rule is one sentence in all
--     five enforcement points instead of one-and-a-half.
--
-- The five enforcement points, all changed together (a per-person read left
-- behind anywhere would be a split brain):
--   1. dial_queue's DNC anti-join            <- here
--   2. pre_call_check's DNC guard            <- here
--   3. is_phone_on_dnc()                     <- here, now takes the owner
--   4. tool-webhook send_text's mobile check <- src/lib/elevenlabs/tool-webhook.ts
--   5. recompute-call-state's status read    <- src/lib/leads/recompute-call-state.ts
-- plus the two Meta-audience exclusions (src/lib/meta/sync.ts and the
-- settings/integrations/meta/export route), which are already per user.
-- tests/dnc-owner-phone-unique.unit.test.ts pins all of them.
--
-- DEPLOY ORDER (feedback_migration_sequencing): ship the PR, let Vercel
-- deploy, THEN push this. is_phone_on_dnc changes signature, so old code
-- calling the 1-arg form would break. Both callers now fail CLOSED on an RPC
-- error (they refuse the dial instead of ignoring it), so the window between
-- deploy and push refuses owner-line dials and browser dials rather than
-- letting a suppressed number through.
--
-- OBLIGATION FOR THE NEXT CHANGE: `create or replace` replaces the WHOLE
-- object. dial_queue below is reproduced in full from
-- 20260810130000_dial_queue_precompute_pool_coverage.sql and pre_call_check
-- in full from 20260724120000_daily_caps_eastern_day.sql; ONLY their DNC
-- predicates differ. Whoever next modifies either must reproduce THIS entire
-- definition, from THIS file (20260718 rebuilt both from five-week-old copies
-- and silently deleted seven safety rules — see tests/dialer-rules).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1) dial_queue: the anti-join now matches the LEAD OWNER's list.
--    Verbatim from 20260810130000 except `and d.owner_id = l.owner_id`.
--    The (owner_id, phone) unique index from 20260905241000 serves it.
--
--    Note the view is security_invoker, so since 20260905192000 gave
--    dnc_entries a per-user SELECT policy this anti-join was ALREADY
--    per-person for anyone reading the view with a cookie client -- only
--    service_role (the dialer tick, which is the reader that matters) still
--    saw every user's rows. This makes the two agree instead of the rule
--    depending on who is looking.
-- ---------------------------------------------------------------------------
create or replace view public.dial_queue
with (security_invoker = true)
as
with pool as materialized (
  -- Usable pool numbers per campaign, mirroring selectPoolNumber's gates
  -- INCLUDING rested_until. Precomputed once so local_match_rank is a semi-join
  -- against a tiny set, not a per-lead scan of the whole pool.
  select
    tn.attached_campaign_id as campaign_id,
    tn.area_code
  from public.twilio_numbers tn
  where tn.released_at is null
    and tn.pool_status = 'active'
    and tn.flagged_for_rotation = false
    and tn.elevenlabs_phone_number_id is not null
    and (tn.rested_until is null or tn.rested_until <= now())
),
pool_states as materialized (
  -- The US states each campaign can dial locally (its usable numbers' area
  -- codes -> states), precomputed once.
  select distinct p.campaign_id, na.state
  from pool p
  join public.nanp_area_codes na on na.area_code = p.area_code
  where na.state is not null
)
select
  q.lead_id,
  q.owner_id,
  q.business_phone,
  q.lead_timezone,
  q.next_call_at,
  q.campaign_id,
  q.agent_id,
  q.twilio_number_id,
  q.calling_hours_start,
  q.calling_hours_end,
  q.calls_per_hour_cap,
  q.calls_per_day_cap,
  q.concurrency_cap_per_user,
  q.daily_spend_cap,
  q.monthly_spend_cap,
  q.dial_priority,
  q.is_redial_due,
  q.redial_number_id,
  q.queue_order,
  q.dest_rank,
  q.local_match_rank
from (
  select
    l.id as lead_id,
    l.owner_id,
    l.business_phone,
    l.timezone as lead_timezone,
    l.next_call_at,
    (
      l.redial_at is not null
      and l.redial_at > now() - interval '10 minutes'
      and l.redial_at <= now()
      and c.double_call_enabled
    ) as is_redial_due,
    l.redial_number_id,
    coalesce(
      case
        when l.redial_at is not null
          and l.redial_at > now() - interval '10 minutes'
          and l.redial_at <= now()
          and c.double_call_enabled -- TOGGLE
        then l.redial_at
      end,
      l.next_call_at
    ) as queue_order,
    c.id as campaign_id,
    c.created_at as campaign_created_at,
    c.agent_id,
    c.twilio_number_id,
    c.calling_hours_start,
    c.calling_hours_end,
    c.calls_per_hour_cap,
    c.calls_per_day_cap,
    c.concurrency_cap_per_user,
    c.daily_spend_cap,
    c.monthly_spend_cap,
    (case when l.status = 'callback' then 0 else 1 end) as dial_priority,
    -- LOCAL MATCH: 0 = United States, 1 = Canada or unparseable.
    (case
       when coalesce(l.retry_counter, 0) <> 0 then 0
       when nl.country = 'US' then 0
       else 1
     end) as dest_rank,
    -- LOCAL MATCH: 0 = campaign has a usable number in this lead's area code,
    -- 1 = one in the same state, 2 = neither. Now a semi-join against the
    -- precomputed per-campaign coverage sets (pool / pool_states) instead of a
    -- correlated scan of the pool per lead.
    (case
       when coalesce(l.retry_counter, 0) <> 0 then 0
       when exists (
         select 1 from pool p
          where p.campaign_id = c.id
            and p.area_code = nl.area_code
       ) then 0
       when nl.state is not null and exists (
         select 1 from pool_states ps
          where ps.campaign_id = c.id
            and ps.state = nl.state
       ) then 1
       else 2
     end) as local_match_rank
  from public.leads l
  join public.campaigns c
    on c.owner_id = l.owner_id
    and c.status = 'active'
    and (c.autopilot_enabled = true or l.status = 'callback')
    and (l.owner_campaign_id is null or l.owner_campaign_id = c.id)
    and (
      exists (
        select 1 from public.list_campaign_attachments lca
        where lca.campaign_id = c.id
          and lca.list_id = l.list_id
          and lca.detached_at is null
      )
      or (
        c.audience_search is not null
        and l.company is not null
        and l.company ilike '%' || c.audience_search || '%'
      )
      or (
        c.smart_list_id is not null
        and exists (
          select 1 from public.smart_list_members slm
          where slm.smart_list_id = c.smart_list_id
            and slm.lead_id = l.id
        )
      )
    )
  left join public.nanp_area_codes nl
    on nl.area_code = substring(l.business_phone from 3 for 3)
  where
    l.deleted_at is null
    and l.business_phone is not null
    and l.status in ('ready_to_call', 'callback')
    and (
          (l.next_call_at is null or l.next_call_at <= now())
       or (
            l.redial_at is not null
            and l.redial_at > now() - interval '10 minutes'
            and l.redial_at <= now()
            and c.double_call_enabled
          )
    )
    -- Pool gate (the number itself is chosen at placement by selectPoolNumber).
    and exists (
      select 1 from public.twilio_numbers tn
       where tn.attached_campaign_id = c.id
         and tn.released_at is null
         and tn.pool_status = 'active'
         and tn.flagged_for_rotation = false
         and tn.elevenlabs_phone_number_id is not null
    )
    and l.line_type is distinct from 'mobile'
    -- DNC, PER PERSON (see the header). Only the LEAD OWNER's own list stops
    -- this lead; a teammate's entry for the same number does not.
    and not exists (
      select 1 from public.dnc_entries d
      where d.phone = l.business_phone
        and d.owner_id = l.owner_id
    )
    and (
      l.status = 'callback'
      or public.is_within_calling_hours(
        l.timezone, c.calling_hours_start, c.calling_hours_end, false
      )
    )
) q
order by q.dial_priority,
  q.is_redial_due desc,
  q.dest_rank,
  q.local_match_rank,
  q.queue_order nulls first;

comment on view public.dial_queue is
  'Leads eligible for the AUTO-dialer: ready, due, not on their OWN owner''s '
  'DNC list, not a mobile, owned by this campaign (or unowned), targeted by an '
  'attached list / audience search / smart list, on an active campaign with '
  '>=1 usable pool number. DNC is enforced per person by product decision '
  '(20260906020000): a number a teammate suppressed does not stop this lead. '
  'Autopilot gates COLD leads only -- scheduled callbacks run regardless, at '
  'whatever time they were booked for. A lead is also due when is_redial_due '
  'is true: an unconsumed double-call redial marker inside its 10-minute '
  'window (redial_at bounded on both sides so a future timestamp cannot pin '
  'it forever) on a campaign whose double_call_enabled is STILL true, so '
  'turning the toggle off drops pending redials on the next tick. '
  'dial_priority orders callbacks (0) ahead of cold leads (1); '
  'within a tier, is_redial_due desc puts a due redial ahead of leads merely '
  'waiting on next_call_at -- the retry cycle already advanced on call 1, so '
  'next_call_at alone would sort a redial days behind. queue_order (redial_at '
  'when due, else next_call_at) is only the tiebreak within that band. The '
  'specific number is chosen at placement by selectPoolNumber '
  '(redial_number_id is preferred when still usable). '
  'Among never-scheduled leads (queue_order null, so all tied), dest_rank '
  'puts US ahead of Canada and local_match_rank (a semi-join against each '
  'campaign''s precomputed pool coverage) puts leads whose area code or state '
  'the campaign can dial locally ahead of the rest. Re-check caps in code.';

grant select on public.dial_queue to authenticated;

-- ---------------------------------------------------------------------------
-- 2) pre_call_check: the DNC guard now matches the LEAD OWNER's list.
--    Verbatim from 20260724120000 except `and owner_id = v_lead.owner_id`.
--    pool_number_usage_24h from that migration is unchanged and not repeated.
-- ---------------------------------------------------------------------------
create or replace function public.pre_call_check(
  in_lead_id uuid,
  in_campaign_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_campaign public.campaigns%rowtype;
  v_calls_last_hour integer;
  v_calls_last_day integer;
  v_active_calls integer;
  v_spend_today numeric;
  v_spend_month numeric;
  v_reserve_per_call constant numeric := 0.10;
begin
  select * into v_lead from public.leads where id = in_lead_id;
  if not found or v_lead.deleted_at is not null then
    return 'lead_missing_or_deleted';
  end if;
  if v_lead.business_phone is null then
    return 'lead_has_no_phone';
  end if;

  -- DNC, PER PERSON (see the header): only the lead owner's own list blocks
  -- this dial. A teammate's entry for the same number does not.
  if exists (
    select 1 from public.dnc_entries
     where phone = v_lead.business_phone
       and owner_id = v_lead.owner_id
  ) then
    return 'lead_on_dnc';
  end if;

  -- NEW with per-person enforcement: a lead parked in the 'dnc' STAGE is never
  -- AI-dialled either, whoever put it there. RLS forbids writing a dnc_entries
  -- row owned by someone else, so when an admin marks a member's lead DNC (the
  -- leads bulk bar / the inline Stage picker) the entry lands on the ADMIN's
  -- list and no longer stops the member's lead -- while the status flip those
  -- paths do lands on the lead itself. dial_queue already drops non-dialable
  -- statuses; this closes the same hole on the Call Now path, and mirrors the
  -- guard the human browser dial has had all along
  -- (src/app/api/twilio/voice-browser-dial/route.ts: lead.status === 'dnc').
  if v_lead.status = 'dnc' then
    return 'lead_on_dnc';
  end if;

  -- Never AI-dial a mobile. Smile & Dial uses an artificial voice; auto-dialing
  -- cell phones is TCPA-restricted, so mobiles imported for manual handling are
  -- hard-blocked here. This covers both the autopilot tick and Call Now (both
  -- run pre_call_check); HUMAN browser dialling does not call this function, so
  -- a person can still ring a mobile by hand -- which is the intent. NULL
  -- line_type (older leads, or lookup skipped) is NOT blocked.
  if v_lead.line_type = 'mobile' then
    return 'lead_is_mobile';
  end if;

  if exists (
    select 1 from public.calls
     where lead_id = in_lead_id
       and status in ('queued', 'dialing', 'ringing', 'in_progress')
       and created_at > now() - interval '15 minutes'
  ) then
    return 'call_in_flight';
  end if;

  select * into v_campaign from public.campaigns where id = in_campaign_id;
  if not found or v_campaign.status <> 'active' then
    return 'campaign_not_active';
  end if;

  -- Pool gate: the campaign must have >=1 usable number. The SPECIFIC number is
  -- chosen at placement by selectPoolNumber (which also enforces per-number
  -- daily caps + rest windows); this only guards "any number available at all".
  if not exists (
    select 1 from public.twilio_numbers tn
     where tn.attached_campaign_id = in_campaign_id
       and tn.released_at is null
       and tn.pool_status = 'active'
       and tn.flagged_for_rotation = false
       and tn.elevenlabs_phone_number_id is not null
  ) then
    return 'campaign_has_no_numbers';
  end if;

  -- Calling hours. A scheduled callback runs at whatever time it was booked
  -- for -- no window, no weekday gate (see CALLBACK POLICY above). Cold
  -- outreach uses the campaign window, weekdays only.
  if v_lead.status <> 'callback'
     and not public.is_within_calling_hours(
       v_lead.timezone,
       v_campaign.calling_hours_start,
       v_campaign.calling_hours_end,
       false
     ) then
    return 'outside_calling_hours';
  end if;

  -- Pacing + hourly/daily call-VOLUME caps pace cold outreach only. A scheduled
  -- callback is an agreed appointment, so it bypasses these throttles.
  if v_lead.status <> 'callback' then
    -- Pacing: keep cold dials at least dial_interval_seconds apart so the
    -- campaign doesn't fire its whole concurrency allotment at once. 0 disables.
    if v_campaign.dial_interval_seconds > 0 and exists (
      select 1 from public.calls
       where campaign_id = in_campaign_id
         and direction = 'outbound'
         and call_mode = 'ai'
         and status <> 'failed'
         and created_at
             > now() - make_interval(secs => v_campaign.dial_interval_seconds)
    ) then
      return 'pacing_wait';
    end if;

    select count(*) into v_calls_last_hour
      from public.calls
     where campaign_id = in_campaign_id
       and direction = 'outbound'
       and call_mode = 'ai'
       and status <> 'failed'
       and created_at >= now() - interval '1 hour';
    if v_calls_last_hour >= v_campaign.calls_per_hour_cap then
      return 'hourly_cap_hit';
    end if;

    select count(*) into v_calls_last_day
      from public.calls
     where campaign_id = in_campaign_id
       and direction = 'outbound'
       and call_mode = 'ai'
       and status <> 'failed'
       and created_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
    if v_calls_last_day >= v_campaign.calls_per_day_cap then
      return 'daily_cap_hit';
    end if;
  end if;

  -- Concurrency (real-time safety) and spend caps (hard budget) STILL apply to
  -- callbacks.
  select count(*) into v_active_calls
    from public.calls c
    join public.leads l on l.id = c.lead_id
   where l.owner_id = v_lead.owner_id
     and c.status in ('queued', 'dialing', 'ringing', 'in_progress');
  if v_active_calls >= v_campaign.concurrency_cap_per_user then
    return 'concurrency_cap_hit';
  end if;

  if v_campaign.daily_spend_cap is not null then
    select
      coalesce(sum((cost_breakdown->>'total')::numeric), 0)
      + (
        count(*) filter (
          where status in ('queued', 'dialing', 'ringing', 'in_progress')
            and (cost_breakdown->>'total') is null
        ) * v_reserve_per_call
      )
      into v_spend_today
      from public.calls
     where campaign_id = in_campaign_id
       and created_at >= (
         date_trunc('day', now() at time zone 'America/New_York')
           at time zone 'America/New_York'
       );
    if v_spend_today >= v_campaign.daily_spend_cap then
      return 'daily_spend_cap_hit';
    end if;
  end if;

  if v_campaign.monthly_spend_cap is not null then
    select
      coalesce(sum((cost_breakdown->>'total')::numeric), 0)
      + (
        count(*) filter (
          where status in ('queued', 'dialing', 'ringing', 'in_progress')
            and (cost_breakdown->>'total') is null
        ) * v_reserve_per_call
      )
      into v_spend_month
      from public.calls
     where campaign_id = in_campaign_id
       and created_at >= (
         date_trunc('month', now() at time zone 'America/New_York')
           at time zone 'America/New_York'
       );
    if v_spend_month >= v_campaign.monthly_spend_cap then
      return 'monthly_spend_cap_hit';
    end if;
  end if;

  return null;
end;
$$;

comment on function public.pre_call_check(uuid, uuid) is
  'Returns null when (lead, campaign) is safe to AI-dial right now, otherwise a '
  'short reason string. DNC is checked against the LEAD OWNER''s list only '
  '(per-person enforcement, 20260906020000), plus the lead''s own ''dnc'' '
  'stage. Leads tagged line_type=''mobile'' are hard-blocked (human browser '
  'dialling bypasses this function by design). Scheduled callbacks ignore '
  'calling hours entirely and bypass pacing + volume caps; concurrency and '
  'spend caps always apply.';

-- The signature is unchanged, so `create or replace` keeps the ACL granted by
-- 20260905170000. Restated so the grant is visible next to the definition
-- (call site: src/lib/dialer/call-now.ts, Call Now on the user client).
grant execute on function public.pre_call_check(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) is_phone_on_dnc: now takes the owner whose list to check.
--
-- The 1-arg form is DROPPED rather than kept alongside. Keeping it would
-- leave a workspace-wide helper one autocomplete away from any future caller
-- -- the exact shape of the split brain this migration exists to remove --
-- and a PostgREST overload resolved only by which argument names the caller
-- happens to send. Two callers exist (src/lib/dialer/call-now.ts, the
-- owner-line screen; src/app/api/twilio/voice-browser-dial/route.ts, the
-- human browser dial); both pass the lead's owner_id and both now refuse the
-- dial when the RPC errors, so the drop cannot fail open.
--
-- It stays SECURITY DEFINER on purpose: an admin dialling a member's lead has
-- to be stopped by the MEMBER's list, and RLS on dnc_entries would hide it
-- from them. The definer bypass is narrower than what it replaces -- the
-- 1-arg form let any signed-in caller test a phone against the ENTIRE
-- workspace list; this one also needs the owner's uuid, and answers one
-- boolean at a time.
-- ---------------------------------------------------------------------------
drop function if exists public.is_phone_on_dnc(text);

create or replace function public.is_phone_on_dnc(
  phone_to_check text,
  owner_to_check uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.dnc_entries
     where phone = phone_to_check
       and owner_id = owner_to_check
  );
$$;

comment on function public.is_phone_on_dnc(text, uuid) is
  'True when phone_to_check is on owner_to_check''s do-not-call list. DNC is '
  'per person: pass the LEAD''s owner_id, never the signed-in user (an admin '
  'dialling a member''s lead must honour the member''s list, not their own).';

-- New functions get no execute grants since 20260905170000, and this is a new
-- signature besides. call-now.ts runs on the user (cookie) client, so
-- authenticated needs it; never anon.
revoke execute on function public.is_phone_on_dnc(text, uuid) from public, anon;
grant execute on function public.is_phone_on_dnc(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Rewrite the comments 20260905192000 / 20260905241000 left behind, which
--    all promise workspace-wide enforcement.
-- ---------------------------------------------------------------------------
comment on table public.dnc_entries is
  'Do-not-call list, private AND enforced per user: each person sees, manages '
  'and is blocked by only their own entries. A number a teammate suppressed '
  'does not stop this owner''s leads from being dialled -- accepted product '
  'decision, see 20260906020000.';

comment on column public.dnc_entries.owner_id is
  'Whose DNC list this entry is on. RLS scopes reads and deletes to the owner, '
  'and dial-time enforcement (dial_queue, pre_call_check, is_phone_on_dnc) '
  'matches owner_id AND phone, so an entry only ever blocks its own owner''s '
  'leads.';

comment on constraint dnc_entries_owner_phone_key on public.dnc_entries is
  'One row per (owner, phone): each user keeps their own list, and that list '
  'blocks that user''s leads only. Also the index the dial-time anti-join '
  'uses (owner_id leading, both columns equality).';
