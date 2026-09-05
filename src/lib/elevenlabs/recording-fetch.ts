import "server-only";

import type { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

/**
 * Call recordings are PULLED from the ElevenLabs API, not pushed to us.
 *
 * ElevenLabs's `post_call_audio` webhook carries the whole call as a base64
 * MP3 inside the JSON body. Vercel rejects request bodies over 4.5 MB before
 * the route ever runs, so ElevenLabs saw HTTP 413 and the recording was lost
 * for most calls longer than ~3 minutes (47 of 72 such calls in one week; 12
 * of 20 booked calls). This module fetches the audio ourselves instead:
 *
 *   GET https://api.elevenlabs.io/v1/convai/conversations/{id}/audio
 *   → 200 audio/mpeg (the full call), 404 when the conversation is unknown or
 *     its audio is not (yet) available.
 *
 * Two entry points share `fetchAndStoreRecording`:
 *   - the post-call transcription webhook schedules one fetch right after the
 *     `calls` row is written (see post-call-webhook.ts), and
 *   - the dialer tick runs `backfillMissingRecordings` every minute so an
 *     earlier miss (a webhook that never arrived, audio not ready yet, a
 *     transient network error) self-heals without anyone noticing.
 *
 * A failure never throws. Each one bumps `calls.recording_fetch_attempts` and
 * leaves the reason in `calls.recording_fetch_error`; after
 * MAX_RECORDING_FETCH_ATTEMPTS the sweep stops retrying that call and the
 * reason stays visible on the row.
 */

const ELEVENLABS_CONVERSATIONS_API =
  "https://api.elevenlabs.io/v1/convai/conversations";

/** Private bucket the app already signs playback URLs from (getCallDetail). */
export const RECORDING_BUCKET = "call-recordings";

/** Storage object path for a call's recording — the same `${callId}.mp3`
 *  convention the pushed-audio handler used, so playback needs no change. */
export function recordingPathForCall(callId: string): string {
  return `${callId}.mp3`;
}

/** How many times the sweep will try one call before giving up on it. */
export const MAX_RECORDING_FETCH_ATTEMPTS = 5;

/** Upper bound on one recording we are willing to hold in memory. The agent's
 *  hard call ceiling is ~1000 s, which ElevenLabs serves as a ~16 MB MP3, so
 *  this is 4x headroom, not a limit anyone should hit. */
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;

/** Per-request ceiling on the ElevenLabs download. A 16 MB file arrives in a
 *  few seconds; anything slower is a stalled connection we'd rather retry
 *  from a later tick than hang a function on. */
const FETCH_TIMEOUT_MS = 20_000;

export type RecordingFetchFailure =
  /** ELEVENLABS_API_KEY isn't set — nothing to fetch with. */
  | "no_api_key"
  /** 404/400/410: the conversation is unknown to ElevenLabs, or its audio
   *  isn't available (not ready yet, or not retained). */
  | "not_found"
  /** Any other non-2xx (401, 429, 5xx …). */
  | "http_error"
  /** fetch() itself threw: DNS, TLS, reset, or our timeout. */
  | "network_error"
  /** The download exceeded MAX_RECORDING_BYTES and was not buffered. */
  | "too_large"
  /** 200 with an empty body — nothing worth storing. */
  | "empty_audio"
  /** The Supabase Storage upload failed. */
  | "could_not_store_audio"
  /** The audio is in Storage but calls.recording_path could not be set. */
  | "could_not_update_call";

export type RecordingFetchResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; reason: RecordingFetchFailure; detail: string | null };

/**
 * Classify a non-2xx ElevenLabs response. Pure so the split is testable:
 * `not_found` is the "audio isn't there" family (404 conversation_not_found,
 * 400/410 for a conversation whose audio was never kept); everything else is
 * an `http_error` (auth, rate limit, outage) that says nothing about the
 * recording itself.
 */
export function classifyRecordingHttpStatus(
  status: number,
): Extract<RecordingFetchFailure, "not_found" | "http_error"> {
  if (status === 404 || status === 400 || status === 410) return "not_found";
  return "http_error";
}

/** Best-effort extraction of ElevenLabs's error code from a JSON error body
 *  (`{"detail":{"code":"conversation_not_found", …}}`), else a trimmed
 *  snippet of the body. Only ever used as a human-readable detail string. */
function errorDetailFromBody(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      detail?: { code?: unknown; message?: unknown } | string;
    };
    const d = parsed?.detail;
    if (d && typeof d === "object") {
      if (typeof d.code === "string") return `HTTP ${status} ${d.code}`;
      if (typeof d.message === "string") return `HTTP ${status} ${d.message}`;
    } else if (typeof d === "string") {
      return `HTTP ${status} ${d}`;
    }
  } catch {
    /* not JSON */
  }
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 120);
  return snippet ? `HTTP ${status} ${snippet}` : `HTTP ${status}`;
}

function apiKey(): string | null {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

/** Download one conversation's MP3. Never throws; every failure comes back as
 *  a typed result so the callers' bookkeeping is uniform. */
async function downloadRecording(
  conversationId: string,
): Promise<
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: RecordingFetchFailure; detail: string | null }
> {
  const key = apiKey();
  if (!key) return { ok: false, reason: "no_api_key", detail: null };

  let res: Response;
  try {
    res = await fetch(
      `${ELEVENLABS_CONVERSATIONS_API}/${encodeURIComponent(conversationId)}/audio`,
      {
        headers: { "xi-api-key": key },
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
  } catch (err) {
    return {
      ok: false,
      reason: "network_error",
      detail: err instanceof Error ? err.message.slice(0, 200) : null,
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      reason: classifyRecordingHttpStatus(res.status),
      detail: errorDetailFromBody(res.status, body),
    };
  }

  // Refuse to buffer something absurd before reading a byte of it.
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RECORDING_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      detail: `content-length ${declared}`,
    };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return {
      ok: false,
      reason: "network_error",
      detail: err instanceof Error ? err.message.slice(0, 200) : null,
    };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, reason: "empty_audio", detail: null };
  }
  if (bytes.byteLength > MAX_RECORDING_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      detail: `${bytes.byteLength} bytes`,
    };
  }
  return { ok: true, bytes };
}

/**
 * Fetch a call's recording from ElevenLabs and store it at
 * `call-recordings/${callId}.mp3`, then point `calls.recording_path` at it
 * (and clear any earlier `recording_fetch_error`).
 *
 * On failure the call row gets `recording_fetch_attempts = priorAttempts + 1`
 * and `recording_fetch_error = "<reason>: <detail>"` so the sweep can decide
 * whether to retry and an operator can see why a recording is missing.
 * `priorAttempts` is the row's current counter (0 from the webhook path; the
 * sweep passes what it read). Never throws.
 */
export async function fetchAndStoreRecording(
  supabase: SupabaseAdmin,
  input: { callId: string; conversationId: string; priorAttempts?: number },
): Promise<RecordingFetchResult> {
  const priorAttempts = input.priorAttempts ?? 0;

  const recordFailure = async (
    reason: RecordingFetchFailure,
    detail: string | null,
  ): Promise<RecordingFetchResult> => {
    try {
      await supabase
        .from("calls")
        .update({
          recording_fetch_attempts: priorAttempts + 1,
          recording_fetch_error: detail ? `${reason}: ${detail}` : reason,
        })
        .eq("id", input.callId);
    } catch {
      /* bookkeeping only — the failure result below is what matters */
    }
    return { ok: false, reason, detail };
  };

  let downloaded: Awaited<ReturnType<typeof downloadRecording>>;
  try {
    downloaded = await downloadRecording(input.conversationId);
  } catch (err) {
    return recordFailure(
      "network_error",
      err instanceof Error ? err.message.slice(0, 200) : null,
    );
  }
  if (!downloaded.ok)
    return recordFailure(downloaded.reason, downloaded.detail);

  const path = recordingPathForCall(input.callId);
  try {
    const { error: uploadError } = await supabase.storage
      .from(RECORDING_BUCKET)
      .upload(path, downloaded.bytes, {
        contentType: "audio/mpeg",
        upsert: true,
      });
    if (uploadError) {
      return recordFailure(
        "could_not_store_audio",
        uploadError.message?.slice(0, 200) ?? null,
      );
    }
  } catch (err) {
    return recordFailure(
      "could_not_store_audio",
      err instanceof Error ? err.message.slice(0, 200) : null,
    );
  }

  try {
    const { error: updateError } = await supabase
      .from("calls")
      .update({ recording_path: path, recording_fetch_error: null })
      .eq("id", input.callId);
    if (updateError) {
      return recordFailure(
        "could_not_update_call",
        updateError.message?.slice(0, 200) ?? null,
      );
    }
  } catch (err) {
    return recordFailure(
      "could_not_update_call",
      err instanceof Error ? err.message.slice(0, 200) : null,
    );
  }

  return { ok: true, path, bytes: downloaded.bytes.byteLength };
}

// ---------------------------------------------------------------------------
// Backfill sweep
// ---------------------------------------------------------------------------

/** The columns the sweep reads; kept flat + primitive so the selection policy
 *  below is a pure function over rows. */
export type RecordingBackfillRow = {
  id: string;
  call_mode: string;
  status: string;
  elevenlabs_conversation_id: string | null;
  recording_path: string | null;
  recording_fetch_attempts: number;
  created_at: string;
  ended_at: string | null;
};

export type RecordingBackfillCandidate = {
  callId: string;
  conversationId: string;
  priorAttempts: number;
};

/** Only calls from the last 90 days: older recordings are past ElevenLabs's
 *  retention and would just burn attempts on 404s. */
const BACKFILL_LOOKBACK_DAYS = 90;

/** Don't touch a call until it has been over for a couple of minutes — the
 *  webhook path's own fetch (scheduled at call end) gets first go, and
 *  ElevenLabs needs a moment to finalize the audio. */
const BACKFILL_SETTLE_MINUTES = 2;

/** The time cutoffs the sweep applies, from one `now` so the DB query and the
 *  in-memory plan agree exactly. */
export function recordingBackfillWindow(now: Date = new Date()): {
  createdAfter: string;
  endedBefore: string;
} {
  return {
    createdAfter: new Date(
      now.getTime() - BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString(),
    endedBefore: new Date(
      now.getTime() - BACKFILL_SETTLE_MINUTES * 60 * 1000,
    ).toISOString(),
  };
}

/**
 * Decide which calls the sweep should fetch this round, given candidate rows.
 * Pure — no DB, no clock — so the policy is unit-testable:
 *
 *  - completed AI calls that have a conversation id but no recording,
 *  - not yet retried MAX_RECORDING_FETCH_ATTEMPTS times,
 *  - created within the lookback window and ended before the settle cutoff,
 *  - fewest attempts first (a fresh miss beats a repeat offender), then the
 *    newest call first (the recording someone is most likely to look for),
 *  - capped at `limit`.
 *
 * The DB query in `backfillMissingRecordings` applies the same predicate so
 * the read stays small; this is the single definition of the rule.
 */
export function planRecordingBackfill(
  rows: RecordingBackfillRow[],
  opts: { now?: Date; limit: number },
): RecordingBackfillCandidate[] {
  const window = recordingBackfillWindow(opts.now);
  return rows
    .filter(
      (r) =>
        r.call_mode === "ai" &&
        r.status === "completed" &&
        typeof r.elevenlabs_conversation_id === "string" &&
        r.elevenlabs_conversation_id.length > 0 &&
        r.recording_path === null &&
        r.recording_fetch_attempts < MAX_RECORDING_FETCH_ATTEMPTS &&
        r.created_at > window.createdAfter &&
        r.ended_at !== null &&
        r.ended_at < window.endedBefore,
    )
    .sort(
      (a, b) =>
        a.recording_fetch_attempts - b.recording_fetch_attempts ||
        (a.created_at < b.created_at
          ? 1
          : a.created_at > b.created_at
            ? -1
            : 0),
    )
    .slice(0, Math.max(0, opts.limit))
    .map((r) => ({
      callId: r.id,
      conversationId: r.elevenlabs_conversation_id as string,
      priorAttempts: r.recording_fetch_attempts,
    }));
}

export type RecordingBackfillSummary = {
  /** Calls the sweep tried this round. */
  attempted: number;
  stored: number;
  failed: number;
  /** Failure reasons → count, so the cron response shows WHY (e.g. a run of
   *  `not_found` means ElevenLabs isn't keeping audio; `http_error` means the
   *  key or the service). */
  failureReasons: Record<string, number>;
  /** Set when the sweep did no work at all: no API key to fetch with, or the
   *  wall-clock budget ran out before the first fetch. */
  skipped?: "no_api_key";
};

/** Wall-clock ceiling for one sweep. It runs at the END of a dialer tick, so
 *  it never delays a dial — but the tick still has to return. */
const BACKFILL_BUDGET_MS = 20_000;

/**
 * One sweep: pick up to `limit` calls missing a recording (see
 * planRecordingBackfill) and fetch each in turn, stopping early once the
 * wall-clock budget is spent. Never throws; a DB or network failure just
 * shows up in the summary. With `limit: 5` every minute a backlog of ~90
 * drains in under twenty minutes.
 */
export async function backfillMissingRecordings(
  supabase: SupabaseAdmin,
  opts: { limit: number; now?: Date; budgetMs?: number },
): Promise<RecordingBackfillSummary> {
  const summary: RecordingBackfillSummary = {
    attempted: 0,
    stored: 0,
    failed: 0,
    failureReasons: {},
  };
  // Without a key every fetch would fail and burn the calls' attempts for
  // nothing (local/dev, or a mis-set env) — do nothing and say so.
  if (!apiKey()) {
    summary.skipped = "no_api_key";
    return summary;
  }
  const startedAt = Date.now();
  const budgetMs = opts.budgetMs ?? BACKFILL_BUDGET_MS;
  const window = recordingBackfillWindow(opts.now);

  let rows: RecordingBackfillRow[] = [];
  try {
    const { data, error } = await supabase
      .from("calls")
      .select(
        "id, call_mode, status, elevenlabs_conversation_id, recording_path, recording_fetch_attempts, created_at, ended_at",
      )
      .eq("call_mode", "ai")
      .eq("status", "completed")
      .not("elevenlabs_conversation_id", "is", null)
      .is("recording_path", null)
      .lt("recording_fetch_attempts", MAX_RECORDING_FETCH_ATTEMPTS)
      .gt("created_at", window.createdAfter)
      .lt("ended_at", window.endedBefore)
      .order("recording_fetch_attempts", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(opts.limit);
    if (error) return summary;
    rows = (data ?? []) as RecordingBackfillRow[];
  } catch {
    return summary;
  }

  for (const c of planRecordingBackfill(rows, {
    now: opts.now,
    limit: opts.limit,
  })) {
    if (Date.now() - startedAt > budgetMs) break;
    summary.attempted++;
    const result = await fetchAndStoreRecording(supabase, c);
    if (result.ok) {
      summary.stored++;
    } else {
      summary.failed++;
      summary.failureReasons[result.reason] =
        (summary.failureReasons[result.reason] ?? 0) + 1;
    }
  }
  return summary;
}
