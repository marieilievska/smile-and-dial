-- claim_lead_for_dial must also be able to claim a due REDIAL, and must not
-- clobber that redial's schedule when it does.
--
-- THE BUG: dial_queue (20260728120000_double_call.sql) surfaces a lead as due
-- either the normal way (next_call_at <= now()) OR because it carries a live
-- double-call marker (redial_at within its 10-minute window, mirrored below).
-- But claim_lead_for_dial -- the atomic claim the dialer takes immediately
-- before placing a call -- has always run its OWN, independent due-check,
-- and that check was never given the matching redial branch. The retry
-- engine (src/lib/dialer/retry-engine.ts, applyRetryForCall) advances
-- next_call_at to 2 or 15 days out in the SAME write that stamps
-- redial_at/redial_number_id, so by the time the dialer tries to claim the
-- row, next_call_at is genuinely days in the future and the old WHERE can
-- never match it. claimLeadForDial() returns false, the tick logs
-- `already_claimed`, and moves on.
--
-- CONSEQUENCE: this made the entire double-call feature a silent no-op.
-- dial_queue would correctly surface a due redial at the front of its tier,
-- but nothing could ever actually claim it -- the row just sits there until
-- its 10-minute window ages out, and no second call is ever placed, for any
-- lead, ever. No error, no log line pointing at the cause -- just a redial
-- that quietly never happens.
--
-- THE FIX, part 1 (WHERE): add the same OR branch dial_queue uses, so a due
-- redial is claimable too.
--
-- THE FIX, part 2 (next_call_at must SURVIVE a redial claim): the plain
-- 2-minute lease this function stamps on every claim is correct for an
-- ordinary dial -- the retry engine overwrites it with the real next
-- schedule once that call ends. A redial call is different: it's flagged
-- `is_redial` and its whole point is that the retry cycle does NOT advance
-- again (call 1, moments earlier, already wrote the lead's real next
-- schedule -- see the `advanceCycle` gate in applyRetryForCall). If this
-- claim overwrote next_call_at with a 2-minute lease anyway, nothing would
-- ever put the real schedule back: the lease would expire, the lead would
-- fall straight back into the cold rotation, and the pair would silently
-- become two independent attempts instead of the one attempt the feature
-- promises. So when the claim is won via the redial branch, next_call_at
-- must be left exactly as it is.
--
-- THE FIX, part 3 (clear the marker HERE, atomically): redial_at /
-- redial_number_id are nulled out in this same UPDATE rather than by the
-- caller afterwards. That's what makes "consume the marker" and "take the
-- lead" a single atomic step -- two ticks racing on the same due redial both
-- attempt this UPDATE, but only one can be the row's writer; the winner's
-- statement clears redial_at as part of committing its own claim, so the
-- loser's WHERE re-evaluates against a now-null redial_at and fails on BOTH
-- branches (next_call_at is still in the future; the redial branch requires
-- redial_at is not null). No separate cleanup step means no gap for a second
-- tick to slip through. It also sweeps a merely-STALE marker off an entirely
-- ordinary claim for free: any claim that wins via the normal next_call_at
-- branch clears whatever redial_at happens to be sitting on the row, live or
-- expired, so a stale marker never lingers past the next dial.
--
-- owner_campaign_id handling is unchanged from 20260717120000.
create or replace function public.claim_lead_for_dial(
  in_lead_id uuid,
  in_campaign_id uuid
) returns boolean
language plpgsql
as $$
begin
  update public.leads
     set next_call_at = case
           when redial_at is not null
            and redial_at > now() - interval '10 minutes'
            and redial_at <= now()
           then next_call_at
           else now() + interval '2 minutes'
         end,
         owner_campaign_id = coalesce(owner_campaign_id, in_campaign_id),
         redial_at = null,
         redial_number_id = null
   where id = in_lead_id
     and (
           next_call_at is null or next_call_at <= now()
        or (redial_at is not null
            and redial_at > now() - interval '10 minutes'
            and redial_at <= now())
     )
     and (owner_campaign_id is null or owner_campaign_id = in_campaign_id);
  return found;
end;
$$;

-- Only the service-role dialer calls this; a user-scoped client would get
-- permission denied on EXECUTE (intentional -- the claim is a server
-- operation). `create or replace function` preserves an existing grant on
-- its own, but re-issuing it here is harmless and keeps this migration
-- self-documenting.
grant execute on function public.claim_lead_for_dial(uuid, uuid) to service_role;
