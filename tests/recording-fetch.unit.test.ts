import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_RECORDING_FETCH_ATTEMPTS,
  backfillMissingRecordings,
  classifyRecordingHttpStatus,
  fetchAndStoreRecording,
  planRecordingBackfill,
  type RecordingBackfillRow,
} from "@/lib/elevenlabs/recording-fetch";

/**
 * Recordings are pulled from the ElevenLabs API instead of pushed to us.
 *
 * THE BUG THIS GUARDS (prod, 2026-09-05): ElevenLabs delivered each recording
 * as a base64 MP3 inside the post_call_audio webhook body. Vercel rejects
 * bodies over 4.5 MB before the route runs (HTTP 413), so 47 of 72 calls over
 * three minutes in one week — and 12 of 20 booked calls — had no recording.
 * These tests pin the pull path: how a fetch failure is classified and
 * recorded, what the sweep picks, and in what order.
 */

const OLD_KEY = process.env.ELEVENLABS_API_KEY;

beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = "test-key";
});
afterEach(() => {
  process.env.ELEVENLABS_API_KEY = OLD_KEY;
  vi.unstubAllGlobals();
});

type SupabaseArg = Parameters<typeof fetchAndStoreRecording>[0];

/**
 * Minimal chainable fake of the Supabase service client covering only what
 * the module touches: `from("calls")` select/update chains (every filter
 * returns the chain; awaiting it yields `rows`) and
 * `storage.from(bucket).upload()`. Updates and uploads are recorded.
 */
function makeFakeSupabase(opts: {
  rows?: RecordingBackfillRow[];
  selectError?: { message: string } | null;
  uploadError?: { message: string } | null;
  updateError?: { message: string } | null;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const uploads: Array<{
    bucket: string;
    path: string;
    bytes: number;
    options: Record<string, unknown>;
  }> = [];
  const selects: string[] = [];

  function chain(result: { data: unknown; error: unknown }) {
    const c: Record<string, unknown> = {};
    for (const m of ["eq", "not", "is", "lt", "gt", "order", "limit"]) {
      c[m] = () => c;
    }
    c.then = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return c;
  }

  const supabase = {
    from(table: string) {
      if (table !== "calls") throw new Error(`unexpected table ${table}`);
      return {
        select: (cols: string) => {
          selects.push(cols);
          return chain({
            data: opts.selectError ? null : (opts.rows ?? []),
            error: opts.selectError ?? null,
          });
        },
        update: (patch: Record<string, unknown>) => {
          updates.push(patch);
          return chain({ data: null, error: opts.updateError ?? null });
        },
      };
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (
          path: string,
          bytes: Buffer,
          options: Record<string, unknown>,
        ) => {
          uploads.push({ bucket, path, bytes: bytes.byteLength, options });
          return { error: opts.uploadError ?? null };
        },
      }),
    },
  };
  return {
    supabase: supabase as unknown as SupabaseArg,
    updates,
    uploads,
    selects,
  };
}

/** A fetch Response stand-in: ElevenLabs's audio endpoint returns raw MP3
 *  bytes on 200 and a JSON `{detail:{code}}` body on an error status. */
function fakeResponse(input: {
  status: number;
  body?: Buffer | string;
  contentLength?: number;
}) {
  const body = input.body ?? Buffer.alloc(0);
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  const headers = new Headers();
  if (input.contentLength !== undefined) {
    headers.set("content-length", String(input.contentLength));
  }
  return {
    ok: input.status >= 200 && input.status < 300,
    status: input.status,
    headers,
    text: async () => buf.toString("utf8"),
    arrayBuffer: async () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

const NOT_FOUND_BODY = JSON.stringify({
  detail: {
    type: "not_found",
    code: "conversation_not_found",
    message: "Conversation with id conv_x not found.",
  },
});

describe("classifyRecordingHttpStatus", () => {
  it("treats 404 / 400 / 410 as the audio not being there", () => {
    expect(classifyRecordingHttpStatus(404)).toBe("not_found");
    expect(classifyRecordingHttpStatus(400)).toBe("not_found");
    expect(classifyRecordingHttpStatus(410)).toBe("not_found");
  });

  it("treats auth, rate-limit and outage statuses as http errors", () => {
    expect(classifyRecordingHttpStatus(401)).toBe("http_error");
    expect(classifyRecordingHttpStatus(429)).toBe("http_error");
    expect(classifyRecordingHttpStatus(500)).toBe("http_error");
    expect(classifyRecordingHttpStatus(503)).toBe("http_error");
  });
});

describe("fetchAndStoreRecording", () => {
  it("stores the MP3 at <callId>.mp3 and points the call at it", async () => {
    const mp3 = Buffer.from("ID3-fake-mp3-bytes");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        fakeResponse({ status: 200, body: mp3, contentLength: mp3.byteLength }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const fake = makeFakeSupabase({});

    const result = await fetchAndStoreRecording(fake.supabase, {
      callId: "call-1",
      conversationId: "conv_abc",
      priorAttempts: 2,
    });

    expect(result).toEqual({
      ok: true,
      path: "call-1.mp3",
      bytes: mp3.byteLength,
    });
    // The right endpoint, authenticated with the workspace key.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/convai/conversations/conv_abc/audio",
    );
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(
      "test-key",
    );
    // Same bucket / path / content type the pushed-audio handler used, so
    // playback (signed URL on recording_path) needs no change.
    expect(fake.uploads).toEqual([
      {
        bucket: "call-recordings",
        path: "call-1.mp3",
        bytes: mp3.byteLength,
        options: { contentType: "audio/mpeg", upsert: true },
      },
    ]);
    // Success sets the path and clears any earlier error; it does NOT touch
    // the attempts counter.
    expect(fake.updates).toEqual([
      { recording_path: "call-1.mp3", recording_fetch_error: null },
    ]);
  });

  it("classifies a 404 as not_found, records the attempt, and stores nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(fakeResponse({ status: 404, body: NOT_FOUND_BODY })),
    );
    const fake = makeFakeSupabase({});

    const result = await fetchAndStoreRecording(fake.supabase, {
      callId: "call-2",
      conversationId: "conv_missing",
      priorAttempts: 1,
    });

    expect(result).toEqual({
      ok: false,
      reason: "not_found",
      detail: "HTTP 404 conversation_not_found",
    });
    expect(fake.uploads).toEqual([]);
    expect(fake.updates).toEqual([
      {
        recording_fetch_attempts: 2,
        recording_fetch_error: "not_found: HTTP 404 conversation_not_found",
      },
    ]);
  });

  it("classifies a thrown fetch as network_error and records the attempt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    const fake = makeFakeSupabase({});

    const result = await fetchAndStoreRecording(fake.supabase, {
      callId: "call-3",
      conversationId: "conv_net",
    });

    expect(result).toEqual({
      ok: false,
      reason: "network_error",
      detail: "fetch failed",
    });
    expect(fake.uploads).toEqual([]);
    // priorAttempts defaults to 0 (the webhook path) → first attempt recorded.
    expect(fake.updates).toEqual([
      {
        recording_fetch_attempts: 1,
        recording_fetch_error: "network_error: fetch failed",
      },
    ]);
  });

  it("classifies a 5xx as http_error (not not_found)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(fakeResponse({ status: 503, body: "upstream" })),
    );
    const fake = makeFakeSupabase({});

    const result = await fetchAndStoreRecording(fake.supabase, {
      callId: "call-4",
      conversationId: "conv_503",
    });

    expect(result).toEqual({
      ok: false,
      reason: "http_error",
      detail: "HTTP 503 upstream",
    });
  });

  it("refuses to buffer a download whose declared size is absurd", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({
        status: 200,
        body: Buffer.from("x"),
        contentLength: 65 * 1024 * 1024,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const fake = makeFakeSupabase({});

    const result = await fetchAndStoreRecording(fake.supabase, {
      callId: "call-5",
      conversationId: "conv_big",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_large");
    expect(fake.uploads).toEqual([]);
  });

  it("reports a failed Storage upload without marking the call as recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          fakeResponse({ status: 200, body: Buffer.from("mp3") }),
        ),
    );
    const fake = makeFakeSupabase({ uploadError: { message: "bucket gone" } });

    const result = await fetchAndStoreRecording(fake.supabase, {
      callId: "call-6",
      conversationId: "conv_up",
    });

    expect(result).toEqual({
      ok: false,
      reason: "could_not_store_audio",
      detail: "bucket gone",
    });
    expect(fake.updates).toEqual([
      {
        recording_fetch_attempts: 1,
        recording_fetch_error: "could_not_store_audio: bucket gone",
      },
    ]);
  });

  it("does not call the network at all without an API key", async () => {
    process.env.ELEVENLABS_API_KEY = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const fake = makeFakeSupabase({});

    const result = await fetchAndStoreRecording(fake.supabase, {
      callId: "call-7",
      conversationId: "conv_nokey",
    });

    expect(result).toEqual({ ok: false, reason: "no_api_key", detail: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const NOW = new Date("2026-09-05T15:00:00.000Z");

function row(over: Partial<RecordingBackfillRow> & { id: string }) {
  return {
    call_mode: "ai",
    status: "completed",
    elevenlabs_conversation_id: `conv_${over.id}`,
    recording_path: null,
    recording_fetch_attempts: 0,
    created_at: "2026-09-05T14:00:00.000Z",
    ended_at: "2026-09-05T14:05:00.000Z",
    ...over,
  } satisfies RecordingBackfillRow;
}

describe("planRecordingBackfill", () => {
  it("keeps only completed AI calls with a conversation id and no recording", () => {
    const rows = [
      row({ id: "ok" }),
      row({ id: "has-recording", recording_path: "has-recording.mp3" }),
      row({ id: "no-conversation", elevenlabs_conversation_id: null }),
      row({ id: "empty-conversation", elevenlabs_conversation_id: "" }),
      row({ id: "still-dialing", status: "dialing" }),
      row({ id: "failed", status: "failed" }),
      row({ id: "human", call_mode: "human" }),
    ];
    expect(
      planRecordingBackfill(rows, { now: NOW, limit: 10 }).map((c) => c.callId),
    ).toEqual(["ok"]);
  });

  it("gives up after MAX_RECORDING_FETCH_ATTEMPTS", () => {
    const rows = [
      row({ id: "fresh", recording_fetch_attempts: 0 }),
      row({
        id: "last-chance",
        recording_fetch_attempts: MAX_RECORDING_FETCH_ATTEMPTS - 1,
      }),
      row({
        id: "exhausted",
        recording_fetch_attempts: MAX_RECORDING_FETCH_ATTEMPTS,
      }),
    ];
    expect(
      planRecordingBackfill(rows, { now: NOW, limit: 10 }).map((c) => c.callId),
    ).toEqual(["fresh", "last-chance"]);
  });

  it("skips calls older than 90 days and calls that ended under two minutes ago", () => {
    const rows = [
      row({ id: "recent" }),
      row({
        id: "ancient",
        created_at: "2026-06-01T00:00:00.000Z",
        ended_at: "2026-06-01T00:05:00.000Z",
      }),
      row({
        id: "just-ended",
        created_at: "2026-09-05T14:50:00.000Z",
        ended_at: "2026-09-05T14:59:00.000Z",
      }),
      row({ id: "never-ended", ended_at: null }),
    ];
    expect(
      planRecordingBackfill(rows, { now: NOW, limit: 10 }).map((c) => c.callId),
    ).toEqual(["recent"]);
  });

  it("orders fewest attempts first, then newest call first, and caps at limit", () => {
    const rows = [
      row({
        id: "retry-old",
        recording_fetch_attempts: 2,
        created_at: "2026-09-01T10:00:00.000Z",
      }),
      row({
        id: "fresh-old",
        recording_fetch_attempts: 0,
        created_at: "2026-09-02T10:00:00.000Z",
      }),
      row({
        id: "fresh-new",
        recording_fetch_attempts: 0,
        created_at: "2026-09-04T10:00:00.000Z",
      }),
      row({
        id: "retry-new",
        recording_fetch_attempts: 1,
        created_at: "2026-09-04T12:00:00.000Z",
      }),
    ];
    const all = planRecordingBackfill(rows, { now: NOW, limit: 10 });
    expect(all.map((c) => c.callId)).toEqual([
      "fresh-new",
      "fresh-old",
      "retry-new",
      "retry-old",
    ]);
    // The plan carries what the fetch needs: conversation id + prior attempts.
    expect(all[0]).toEqual({
      callId: "fresh-new",
      conversationId: "conv_fresh-new",
      priorAttempts: 0,
    });
    expect(
      planRecordingBackfill(rows, { now: NOW, limit: 2 }).map((c) => c.callId),
    ).toEqual(["fresh-new", "fresh-old"]);
  });
});

describe("backfillMissingRecordings", () => {
  it("fetches each candidate and tallies stored vs failed by reason", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("conv_a")) {
        return fakeResponse({ status: 200, body: Buffer.from("mp3-a") });
      }
      return fakeResponse({ status: 404, body: NOT_FOUND_BODY });
    });
    vi.stubGlobal("fetch", fetchMock);
    const fake = makeFakeSupabase({
      rows: [row({ id: "a" }), row({ id: "b", recording_fetch_attempts: 1 })],
    });

    const summary = await backfillMissingRecordings(fake.supabase, {
      limit: 5,
      now: NOW,
    });

    expect(summary).toEqual({
      attempted: 2,
      stored: 1,
      failed: 1,
      failureReasons: { not_found: 1 },
    });
    expect(fake.uploads.map((u) => u.path)).toEqual(["a.mp3"]);
    expect(fake.updates).toEqual([
      { recording_path: "a.mp3", recording_fetch_error: null },
      {
        recording_fetch_attempts: 2,
        recording_fetch_error: "not_found: HTTP 404 conversation_not_found",
      },
    ]);
  });

  it("does nothing — not even a DB read — without an API key", async () => {
    process.env.ELEVENLABS_API_KEY = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const fake = makeFakeSupabase({ rows: [row({ id: "a" })] });

    const summary = await backfillMissingRecordings(fake.supabase, {
      limit: 5,
    });

    expect(summary).toEqual({
      attempted: 0,
      stored: 0,
      failed: 0,
      failureReasons: {},
      skipped: "no_api_key",
    });
    expect(fake.selects).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an empty summary instead of throwing when the DB read fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const fake = makeFakeSupabase({ selectError: { message: "timeout" } });

    const summary = await backfillMissingRecordings(fake.supabase, {
      limit: 5,
    });

    expect(summary).toEqual({
      attempted: 0,
      stored: 0,
      failed: 0,
      failureReasons: {},
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
