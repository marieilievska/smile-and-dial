import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

import {
  RETENTION_DAYS,
  partitionRecordingRows,
  retentionCutoff,
} from "./retention-window";

type Admin = SupabaseClient<Database>;

const RECORDINGS_BUCKET = "call-recordings";

export type RetentionSummary = {
  days: number;
  /** ISO instant; rows created/received before this were eligible. */
  cutoff: string;
  recordingsRemoved: number;
  transcriptsCleared: number;
  webhookRowsDeleted: number;
  /** What is STILL past the cutoff after this run (null = the count itself
   *  failed). Non-zero means the run hit its time budget or an error and the
   *  next nightly run will pick up where this one left off. */
  remaining: {
    recordings: number | null;
    transcripts: number | null;
    webhookRows: number | null;
  };
  errors: string[];
  durationMs: number;
};

export type RetentionOptions = {
  /** Retention window in days. Default RETENTION_DAYS (90). */
  days?: number;
  /** Rows per batch. Default 200. */
  limit?: number;
  /** Wall-clock budget for the whole sweep. The pg_net caller times out at
   *  30s, so stay comfortably under it; whatever is left waits for tomorrow.
   *  Default 20s. */
  budgetMs?: number;
  /** Injectable clock for tests. */
  now?: Date;
};

type Ctx = {
  cutoff: string;
  limit: number;
  withinBudget: () => boolean;
  errors: string[];
};

/**
 * Nightly retention sweep. Removes from OUR side everything past the
 * retention window, in three independent stages:
 *
 *   1. Recordings — delete the audio object from the private bucket, then
 *      null `calls.recording_path`. Legacy http(s) URLs (Twilio-hosted human
 *      call recordings we don't own) just get the column nulled.
 *   2. Transcripts — null `calls.transcript_json`. NOTHING else on the call
 *      row is touched: summary, extracted_data, objection_*, cost_breakdown
 *      and callback_notes stay forever.
 *   3. Webhook log — delete `elevenlabs_webhook_events` rows older than the
 *      window. The table only backs (conversation_id, event_type)
 *      idempotency, and ElevenLabs never retries a 90-day-old event.
 *
 * Each stage loops in batches (oldest first) until nothing is left or the
 * time budget runs out, and swallows its own errors — partial progress is
 * fine because the cron repeats every night. Never throws.
 */
export async function runRetentionSweep(
  admin: Admin,
  opts: RetentionOptions = {},
): Promise<RetentionSummary> {
  const days = opts.days ?? RETENTION_DAYS;
  const limit = opts.limit ?? 200;
  const budgetMs = opts.budgetMs ?? 20_000;
  const now = opts.now ?? new Date();
  const startedAt = Date.now();
  const ctx: Ctx = {
    cutoff: retentionCutoff(days, now).toISOString(),
    limit,
    withinBudget: () => Date.now() - startedAt < budgetMs,
    errors: [],
  };

  const recordingsRemoved = await sweepRecordings(admin, ctx);
  const transcriptsCleared = await sweepTranscripts(admin, ctx);
  const webhookRowsDeleted = await sweepWebhookLog(admin, ctx);
  const remaining = await countRemaining(admin, ctx);

  const summary: RetentionSummary = {
    days,
    cutoff: ctx.cutoff,
    recordingsRemoved,
    transcriptsCleared,
    webhookRowsDeleted,
    remaining,
    errors: ctx.errors,
    durationMs: Date.now() - startedAt,
  };

  // One audit row per night that actually removed something — quiet nights
  // (nothing past the window yet) leave no trace, so the log stays readable.
  if (recordingsRemoved + transcriptsCleared + webhookRowsDeleted > 0) {
    try {
      const { error } = await admin.from("system_events").insert({
        kind: "retention_sweep",
        actor_user_id: null,
        ref_table: null,
        ref_id: null,
        payload: summary as unknown as Json,
      });
      if (error) ctx.errors.push(`system_events: ${error.message}`);
    } catch (error) {
      ctx.errors.push(`system_events: ${errorMessage(error)}`);
    }
  }

  return summary;
}

async function sweepRecordings(admin: Admin, ctx: Ctx): Promise<number> {
  let removed = 0;
  try {
    while (ctx.withinBudget()) {
      const { data, error } = await admin
        .from("calls")
        .select("id, recording_path")
        .not("recording_path", "is", null)
        .lt("created_at", ctx.cutoff)
        .order("created_at", { ascending: true })
        .limit(ctx.limit);
      if (error) {
        ctx.errors.push(`recordings: select failed: ${error.message}`);
        break;
      }
      const rows = data ?? [];
      if (rows.length === 0) break;

      const { storagePaths, callIds } = partitionRecordingRows(rows);
      if (storagePaths.length > 0) {
        // Delete the objects FIRST; only null the column once the bucket
        // confirms. A missing object is not an error (already gone), so a
        // half-finished night converges on the next run.
        const { error: removeError } = await admin.storage
          .from(RECORDINGS_BUCKET)
          .remove(storagePaths);
        if (removeError) {
          ctx.errors.push(
            `recordings: storage remove failed: ${removeError.message}`,
          );
          break;
        }
      }
      if (callIds.length === 0) break;

      // The ids came from a cutoff-bounded select, but keep the guard on
      // the write too: nothing newer than the window can ever be nulled.
      const { error: updateError, count } = await admin
        .from("calls")
        .update({ recording_path: null }, { count: "exact" })
        .lt("created_at", ctx.cutoff)
        .in("id", callIds);
      if (updateError) {
        ctx.errors.push(`recordings: update failed: ${updateError.message}`);
        break;
      }
      const n = count ?? callIds.length;
      removed += n;
      // A zero-row update means the batch was already handled (or a race);
      // don't spin re-selecting the same rows until the budget runs out.
      if (n === 0 || rows.length < ctx.limit) break;
    }
  } catch (error) {
    ctx.errors.push(`recordings: ${errorMessage(error)}`);
  }
  return removed;
}

async function sweepTranscripts(admin: Admin, ctx: Ctx): Promise<number> {
  let cleared = 0;
  try {
    while (ctx.withinBudget()) {
      const { data, error } = await admin
        .from("calls")
        .select("id")
        .not("transcript_json", "is", null)
        .lt("created_at", ctx.cutoff)
        .order("created_at", { ascending: true })
        .limit(ctx.limit);
      if (error) {
        ctx.errors.push(`transcripts: select failed: ${error.message}`);
        break;
      }
      const ids = (data ?? []).map((r) => r.id);
      if (ids.length === 0) break;

      const { error: updateError, count } = await admin
        .from("calls")
        .update({ transcript_json: null }, { count: "exact" })
        .lt("created_at", ctx.cutoff)
        .in("id", ids);
      if (updateError) {
        ctx.errors.push(`transcripts: update failed: ${updateError.message}`);
        break;
      }
      const n = count ?? ids.length;
      cleared += n;
      if (n === 0 || ids.length < ctx.limit) break;
    }
  } catch (error) {
    ctx.errors.push(`transcripts: ${errorMessage(error)}`);
  }
  return cleared;
}

async function sweepWebhookLog(admin: Admin, ctx: Ctx): Promise<number> {
  let deleted = 0;
  try {
    while (ctx.withinBudget()) {
      const { data, error } = await admin
        .from("elevenlabs_webhook_events")
        .select("conversation_id")
        .lt("received_at", ctx.cutoff)
        .order("received_at", { ascending: true })
        .limit(ctx.limit);
      if (error) {
        ctx.errors.push(`webhook log: select failed: ${error.message}`);
        break;
      }
      const rows = data ?? [];
      if (rows.length === 0) break;
      // The PK is (conversation_id, event_type); one conversation can hold
      // a transcript + audio + failure row. Delete by conversation, but keep
      // the received_at guard so a fresh event for an old id is never hit.
      const ids = [...new Set(rows.map((r) => r.conversation_id))];

      const { error: deleteError, count } = await admin
        .from("elevenlabs_webhook_events")
        .delete({ count: "exact" })
        .lt("received_at", ctx.cutoff)
        .in("conversation_id", ids);
      if (deleteError) {
        ctx.errors.push(`webhook log: delete failed: ${deleteError.message}`);
        break;
      }
      const n = count ?? rows.length;
      deleted += n;
      if (n === 0 || rows.length < ctx.limit) break;
    }
  } catch (error) {
    ctx.errors.push(`webhook log: ${errorMessage(error)}`);
  }
  return deleted;
}

async function countRemaining(
  admin: Admin,
  ctx: Ctx,
): Promise<RetentionSummary["remaining"]> {
  const remaining: RetentionSummary["remaining"] = {
    recordings: null,
    transcripts: null,
    webhookRows: null,
  };
  try {
    const { count, error } = await admin
      .from("calls")
      .select("id", { count: "exact", head: true })
      .not("recording_path", "is", null)
      .lt("created_at", ctx.cutoff);
    if (error) ctx.errors.push(`remaining recordings: ${error.message}`);
    else remaining.recordings = count ?? 0;
  } catch (error) {
    ctx.errors.push(`remaining recordings: ${errorMessage(error)}`);
  }
  try {
    const { count, error } = await admin
      .from("calls")
      .select("id", { count: "exact", head: true })
      .not("transcript_json", "is", null)
      .lt("created_at", ctx.cutoff);
    if (error) ctx.errors.push(`remaining transcripts: ${error.message}`);
    else remaining.transcripts = count ?? 0;
  } catch (error) {
    ctx.errors.push(`remaining transcripts: ${errorMessage(error)}`);
  }
  try {
    const { count, error } = await admin
      .from("elevenlabs_webhook_events")
      .select("conversation_id", { count: "exact", head: true })
      .lt("received_at", ctx.cutoff);
    if (error) ctx.errors.push(`remaining webhook rows: ${error.message}`);
    else remaining.webhookRows = count ?? 0;
  } catch (error) {
    ctx.errors.push(`remaining webhook rows: ${errorMessage(error)}`);
  }
  return remaining;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
