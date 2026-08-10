import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { chunk } from "@/lib/leads/chunk";
import type { Database } from "@/lib/supabase/database.types";

/**
 * One pending callback joined to its lead's current state — the input the sweep
 * decision needs. Kept flat + primitive so the decision is a pure function.
 */
export type CallbackSweepRow = {
  callbackId: string;
  leadId: string;
  scheduledAt: string;
  leadStatus: string;
  leadLineType: string | null;
  leadDeleted: boolean;
};

export type CallbackSweepPlan = {
  /** Pending callbacks to cancel (their lead can never be dialed as a callback). */
  cancelCallbackIds: string[];
  /** Dialable leads to re-park as callbacks, pointed at their earliest pending. */
  resync: { leadId: string; nextCallAt: string }[];
};

/** Statuses from which the dialer will actually place a callback dial. */
const DIALABLE_STATUSES = new Set(["ready_to_call", "callback"]);

/**
 * Decide how to unstick pending callbacks, given every pending callback joined
 * to its lead. Pure — no DB, no clock — so the policy is unit-testable.
 *
 * A pending callback only ever closes when its lead is dialed while still in
 * `callback` status; nothing else revisits it. So two states leave a callback
 * stranded:
 *
 *  - **Zombie:** the lead moved to a non-dialable status (goal_met / dnc /
 *    resting / …) or was soft-deleted while a callback stayed pending. It will
 *    never be dialed → cancel the callback (it shows as "overdue" forever).
 *  - **Mis-parked:** the lead is `ready_to_call` (dialable) but still has a
 *    pending callback — its status was reset out of `callback` without the
 *    callback being cleared, so its scheduled time is ignored and it dials as a
 *    cold lead. Re-park it as a callback pointed at its EARLIEST pending one.
 *
 * Mobile leads are never re-parked (the mobile lock means they never auto-dial,
 * so parking them as callbacks would just create a different stuck state).
 * Correctly-parked `callback` leads are left untouched.
 */
export function decideCallbackSweep(
  rows: CallbackSweepRow[],
): CallbackSweepPlan {
  const cancelCallbackIds: string[] = [];
  // Earliest pending callback per kept (dialable, live) lead.
  const keptByLead = new Map<
    string,
    { status: string; lineType: string | null; earliest: string }
  >();

  for (const r of rows) {
    const dialable = !r.leadDeleted && DIALABLE_STATUSES.has(r.leadStatus);
    if (!dialable) {
      cancelCallbackIds.push(r.callbackId);
      continue;
    }
    const cur = keptByLead.get(r.leadId);
    if (!cur) {
      keptByLead.set(r.leadId, {
        status: r.leadStatus,
        lineType: r.leadLineType,
        earliest: r.scheduledAt,
      });
    } else if (new Date(r.scheduledAt) < new Date(cur.earliest)) {
      cur.earliest = r.scheduledAt;
    }
  }

  const resync: { leadId: string; nextCallAt: string }[] = [];
  for (const [leadId, info] of keptByLead) {
    if (info.status === "ready_to_call" && info.lineType !== "mobile") {
      resync.push({ leadId, nextCallAt: info.earliest });
    }
  }

  return { cancelCallbackIds, resync };
}

const PENDING_PAGE = 1000;
const CANCEL_CHUNK = 200;

/**
 * Sweep stuck callbacks across the whole workspace (service-role client): cancel
 * zombie callbacks and re-park mis-statused dialable leads (see
 * {@link decideCallbackSweep}). Idempotent — every write re-checks the row's
 * status, so concurrent ticks and repeated runs are safe. Cheap: it only ever
 * scans PENDING callbacks (a small set), paged past PostgREST's 1,000-row cap.
 */
export async function sweepStuckCallbacks(
  supabase: SupabaseClient<Database>,
): Promise<{ cancelled: number; resynced: number }> {
  const rows: CallbackSweepRow[] = [];
  let lastId: string | null = null;
  for (;;) {
    let query = supabase
      .from("callbacks")
      .select(
        "id, lead_id, scheduled_at, lead:leads!inner(status, line_type, deleted_at)",
      )
      .eq("status", "pending")
      .order("id", { ascending: true })
      .limit(PENDING_PAGE);
    if (lastId !== null) query = query.gt("id", lastId);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as {
      id: string;
      lead_id: string;
      scheduled_at: string;
      lead: {
        status: string;
        line_type: string | null;
        deleted_at: string | null;
      } | null;
    }[];
    for (const r of page) {
      rows.push({
        callbackId: r.id,
        leadId: r.lead_id,
        scheduledAt: r.scheduled_at,
        leadStatus: r.lead?.status ?? "",
        leadLineType: r.lead?.line_type ?? null,
        leadDeleted: r.lead?.deleted_at != null,
      });
    }
    if (page.length < PENDING_PAGE) break;
    lastId = page[page.length - 1].id;
  }

  const plan = decideCallbackSweep(rows);

  let cancelled = 0;
  for (const ids of chunk(plan.cancelCallbackIds, CANCEL_CHUNK)) {
    const { error } = await supabase
      .from("callbacks")
      .update({ status: "cancelled" })
      .in("id", ids)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    cancelled += ids.length;
  }

  let resynced = 0;
  for (const r of plan.resync) {
    // Guard on ready_to_call so we never clobber a lead the dialer/operator
    // moved on in the meantime.
    const { error } = await supabase
      .from("leads")
      .update({ status: "callback", next_call_at: r.nextCallAt })
      .eq("id", r.leadId)
      .eq("status", "ready_to_call");
    if (error) throw new Error(error.message);
    resynced++;
  }

  return { cancelled, resynced };
}
