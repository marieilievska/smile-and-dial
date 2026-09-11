import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dial-time number gate, wired into every path that dials.
 *
 * ElevenLabs is handed a lead's stored number verbatim as `to_number`. Until
 * this gate nothing checked its shape: dial_queue, pre_call_check and
 * claim_lead_for_dial only ask whether it is null, and the number pool reads
 * an area code it can't parse as "no local match", not "don't dial". So a CSV
 * import's raw "+44 20 7946 0958", or an inbound caller's "anonymous", would
 * be claimed, given a pool number and dialed, on Eastern calling hours because
 * neither has a timezone.
 *
 * These run the REAL autopilot tick, Call Now and placeAgentCall. The Supabase
 * URL is https://offline.invalid, which never resolves: a stubbed global fetch
 * answers every PostgREST (and ElevenLabs) request and records it. So the
 * assertions are about what each path actually asked for, and nothing here can
 * reach production or place a call.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Call Now signs in through the cookie client, which can't run under Vitest.
// Everything else it asks goes through PostgREST, so the stand-in serves both:
// a real client pointed at the offline URL, with only the sign-in faked.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const rest = createClient("https://offline.invalid", "offline-anon-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-1" } },
          error: null,
        }),
      },
      from: (table: string) => rest.from(table),
      rpc: (fn: string, args?: Record<string, unknown>) => rest.rpc(fn, args),
    };
  },
}));

import { callNow } from "@/lib/dialer/call-now";
import { runDialerTick, type QueueRow } from "@/lib/dialer/tick";
import { placeAgentCall } from "@/lib/twilio/place-call";

const CAMPAIGN = "c0000000-0000-4000-8000-000000000001";
const US_LEAD = "1ead0000-0000-4000-8000-000000000001";
const GATED_LEAD = "1ead0000-0000-4000-8000-000000000002";

type Recorded = {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Record<string, unknown>;
};

/**
 * An offline PostgREST that records every request. Reads return rows (one
 * object when the client asked for exactly one); writes succeed and match
 * nothing, except an insert that asks for its new row back.
 */
function standIn(
  opts: {
    queue?: QueueRow[];
    lead?: Record<string, unknown>;
    alertFire?: boolean;
    preCallCheck?: (leadId: string) => string | null;
  } = {},
) {
  const requests: Recorded[] = [];
  const fetchStub = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init.method ?? "GET").toUpperCase();
      const headers = new Headers(init.headers);
      const raw =
        typeof init.body === "string" && init.body !== ""
          ? JSON.parse(init.body)
          : {};
      const body = ((Array.isArray(raw) ? raw[0] : raw) ?? {}) as Record<
        string,
        unknown
      >;
      requests.push({
        method,
        path: url.pathname,
        params: url.searchParams,
        body,
      });

      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });
      const one = (headers.get("accept") ?? "").includes("vnd.pgrst.object");

      const rpc = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname)?.[1];
      if (rpc === "pre_call_check") {
        return json(opts.preCallCheck?.(String(body.in_lead_id)) ?? null);
      }
      if (rpc === "claim_lead_for_dial") return json(true);
      if (rpc === "alert_fire") return json(opts.alertFire ?? true);
      if (rpc) return json(null);

      const table = url.pathname.replace(/^\/rest\/v1\//, "");
      if (method === "GET") {
        if (table === "campaigns") {
          return json([
            { id: CAMPAIGN, agent_id: "agent-1", dial_interval_seconds: 0 },
          ]);
        }
        if (table === "dial_queue") return json(opts.queue ?? []);
        if (table === "list_campaign_attachments") {
          return json([{ id: "attachment-1" }]);
        }
        if (table === "leads" && opts.lead) {
          return json(one ? opts.lead : [opts.lead]);
        }
        return json(one ? { call_attempts: 0 } : []);
      }
      if ((headers.get("prefer") ?? "").includes("return=representation")) {
        if (method !== "POST") return json([]);
        const row = { id: `${table}-${requests.length}` };
        return json(one ? row : [row], 201);
      }
      return new Response(null, { status: method === "POST" ? 201 : 204 });
    },
  );
  return { requests, fetchStub };
}

const rpcsFor = (reqs: Recorded[], fn: string, leadId: string) =>
  reqs.filter(
    (r) => r.path === `/rest/v1/rpc/${fn}` && r.body.in_lead_id === leadId,
  );
const callRowsFor = (reqs: Recorded[], leadId: string) =>
  reqs.filter(
    (r) =>
      r.method === "POST" &&
      r.path === "/rest/v1/calls" &&
      r.body.lead_id === leadId,
  );
const leadPatches = (reqs: Recorded[], leadId: string) =>
  reqs.filter(
    (r) =>
      r.method === "PATCH" &&
      r.path === "/rest/v1/leads" &&
      r.params.get("id") === `eq.${leadId}`,
  );
const eventInserts = (reqs: Recorded[]) =>
  reqs.filter(
    (r) => r.method === "POST" && r.path === "/rest/v1/system_events",
  );

function queueRow(
  leadId: string,
  phone: string | null,
  over: Partial<QueueRow> = {},
): QueueRow {
  return {
    lead_id: leadId,
    owner_id: "user-1",
    business_phone: phone,
    campaign_id: CAMPAIGN,
    agent_id: "agent-1",
    is_redial_due: false,
    redial_number_id: null,
    dial_priority: 1,
    ...over,
  };
}

beforeEach(() => {
  // Mock mode (no Twilio, no ElevenLabs), pointed at the offline stand-in.
  // Set explicitly so a real key in the shell can't switch anything on.
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://offline.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "offline-service-key");
  vi.stubEnv("TWILIO_LIVE", "");
  vi.stubEnv("ELEVENLABS_LIVE", "");
  vi.stubEnv("ELEVENLABS_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the autopilot tick never dials a number that isn't +1", () => {
  it.each([
    ["a foreign number the import kept as text", "+44 20 7946 0958"],
    ["a foreign number in E.164", "+442079460958"],
    ["an inbound caller ID that isn't a number", "anonymous"],
    ["a US number that was never normalized", "(205) 259-8928"],
    ["an empty string", ""],
  ])(
    "%s is skipped as blocked while the +1 lead beside it is dialed",
    async (_what, phone) => {
      const db = standIn({
        queue: [queueRow(GATED_LEAD, phone), queueRow(US_LEAD, "+12052598928")],
      });
      vi.stubGlobal("fetch", db.fetchStub);

      const summary = await runDialerTick();

      // The +1 lead went all the way through, so the harness really dials.
      expect(callRowsFor(db.requests, US_LEAD)).toHaveLength(1);
      // The other never reached the safety check, the claim or a call row.
      expect(rpcsFor(db.requests, "pre_call_check", GATED_LEAD)).toHaveLength(
        0,
      );
      expect(
        rpcsFor(db.requests, "claim_lead_for_dial", GATED_LEAD),
      ).toHaveLength(0);
      expect(callRowsFor(db.requests, GATED_LEAD)).toHaveLength(0);
      // Blocked, never an error: dialer_stalled reads a run of errors as a
      // faulting dialer, and a list whose last leads are foreign isn't one.
      expect(summary).toMatchObject({
        candidates: 2,
        dialed: 1,
        blocked: 1,
        errors: 0,
      });
      expect(summary.blockedReasons).toEqual({ lead_phone_not_us_ca: 1 });
    },
  );

  it.each([
    ["a scheduled callback", { dial_priority: 0 }],
    [
      "a due double-call redial",
      { is_redial_due: true, redial_number_id: "number-1" },
    ],
  ])(
    "%s, which skips calling hours and caps, is gated all the same",
    async (_what, over) => {
      const db = standIn({
        queue: [queueRow(GATED_LEAD, "+442079460958", over)],
      });
      vi.stubGlobal("fetch", db.fetchStub);

      const summary = await runDialerTick();

      expect(callRowsFor(db.requests, GATED_LEAD)).toHaveLength(0);
      expect(summary.blockedReasons).toEqual({ lead_phone_not_us_ca: 1 });
    },
  );
});

describe("the tick's skip is visible", () => {
  it("on the lead's own Activity feed, once alert_fire lets it", async () => {
    const db = standIn({ queue: [queueRow(GATED_LEAD, "+442079460958")] });
    vi.stubGlobal("fetch", db.fetchStub);

    await runDialerTick();

    expect(
      db.requests
        .filter((r) => r.path === "/rest/v1/rpc/alert_fire")
        .map((r) => r.body),
    ).toEqual([
      {
        in_rule: "event:lead_phone_not_us_ca",
        in_ref: GATED_LEAD,
        in_period: "7 days",
      },
    ]);
    // The lead page reads system_events by ref_table 'leads' + ref_id.
    expect(eventInserts(db.requests).map((r) => r.body)).toEqual([
      expect.objectContaining({
        kind: "lead_phone_not_us_ca",
        ref_table: "leads",
        ref_id: GATED_LEAD,
        payload: { lead_id: GATED_LEAD, campaign_id: CAMPAIGN },
      }),
    ]);
  });

  it("at most once a week per lead: a refused claim writes no row", async () => {
    // One row per meeting is how pool_exhausted buried the Activity feed
    // under 20,535 rows in five days (#309).
    const db = standIn({
      queue: [queueRow(GATED_LEAD, "+442079460958")],
      alertFire: false,
    });
    vi.stubGlobal("fetch", db.fetchStub);

    const summary = await runDialerTick();

    expect(eventInserts(db.requests)).toHaveLength(0);
    expect(callRowsFor(db.requests, GATED_LEAD)).toHaveLength(0);
    expect(summary.blockedReasons).toEqual({ lead_phone_not_us_ca: 1 });
  });
});

describe("the tick re-checks a gated lead hourly, not every minute", () => {
  it("pushes next_call_at out an hour and touches nothing else", async () => {
    const db = standIn({ queue: [queueRow(GATED_LEAD, "+442079460958")] });
    vi.stubGlobal("fetch", db.fetchStub);
    const before = Date.now();

    await runDialerTick();

    const bumps = leadPatches(db.requests, GATED_LEAD);
    expect(bumps.map((r) => Object.keys(r.body))).toEqual([["next_call_at"]]);
    const pushedBy = Date.parse(String(bumps[0].body.next_call_at)) - before;
    expect(pushedBy).toBeGreaterThanOrEqual(60 * 60_000);
    expect(pushedBy).toBeLessThan(61 * 60_000);
  });

  it("leaves a due redial's schedule alone", async () => {
    // Its next_call_at already holds call 1's 2-15 day backoff; an hour
    // from now would pull that in, not push it out.
    const db = standIn({
      queue: [
        queueRow(GATED_LEAD, "+442079460958", {
          is_redial_due: true,
          redial_number_id: "number-1",
        }),
      ],
    });
    vi.stubGlobal("fetch", db.fetchStub);

    await runDialerTick();

    expect(leadPatches(db.requests, GATED_LEAD)).toHaveLength(0);
  });
});

describe("Call Now never dials a number that isn't +1", () => {
  const leadRow = (over: Record<string, unknown>) => ({
    id: GATED_LEAD,
    list_id: "list-1",
    owner_id: "user-1",
    business_phone: "+12052598928",
    owner_phone: null,
    owner_campaign_id: null,
    ...over,
  });

  it.each([
    ["a foreign number", "+442079460958"],
    ["an inbound caller ID that isn't a number", "anonymous"],
    ["a US number that was never normalized", "(205) 259-8928"],
  ])(
    "refuses %s on the business line before doing anything else",
    async (_what, phone) => {
      const db = standIn({ lead: leadRow({ business_phone: phone }) });
      vi.stubGlobal("fetch", db.fetchStub);

      const res = await callNow({ leadId: GATED_LEAD, campaignId: CAMPAIGN });

      // Matched on the whole result, so a failure shows the callId it got.
      expect(res).toMatchObject({
        error: expect.stringMatching(
          /^This lead's number isn't a US or Canadian number/,
        ),
      });
      expect(res.callId).toBeUndefined();
      // The lead was read and nothing else: no call reaping, no safety
      // check, no ownership stamp, no call row.
      expect(db.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /rest/v1/leads",
      ]);
    },
  );

  it("refuses a foreign number on the owner line", async () => {
    const db = standIn({ lead: leadRow({ owner_phone: "+442079460958" }) });
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await callNow({
      leadId: GATED_LEAD,
      campaignId: CAMPAIGN,
      target: "owner",
    });

    expect(res).toMatchObject({
      error: expect.stringMatching(
        /^The owner's number isn't a US or Canadian number/,
      ),
    });
    expect(db.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /rest/v1/leads",
    ]);
  });

  it("still dials a +1 number", async () => {
    const db = standIn({ lead: leadRow({}) });
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await callNow({ leadId: GATED_LEAD, campaignId: CAMPAIGN });

    expect(res.error).toBeNull();
    expect(rpcsFor(db.requests, "pre_call_check", GATED_LEAD)).toHaveLength(1);
    expect(callRowsFor(db.requests, GATED_LEAD)).toHaveLength(1);
  });

  it("leaves a missing number to pre_call_check, which names that case", async () => {
    const db = standIn({
      lead: leadRow({ business_phone: null }),
      preCallCheck: () => "lead_has_no_phone",
    });
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await callNow({ leadId: GATED_LEAD, campaignId: CAMPAIGN });

    expect(res.error).toBe("Lead has no phone number.");
  });
});

describe("placeAgentCall, the last hop, refuses anything but +1", () => {
  const input = (toNumber: string) => ({
    callId: "call-1",
    toNumber,
    elevenlabsAgentId: "agent_el_1",
    elevenlabsPhoneNumberId: "phnum_1",
  });

  it("refuses in mock mode instead of faking a placed call", async () => {
    const res = await placeAgentCall(input("+442079460958"));

    expect(res.ok).toBe(false);
  });

  it("refuses in live mode before ElevenLabs is ever asked", async () => {
    vi.stubEnv("ELEVENLABS_LIVE", "live");
    vi.stubEnv("ELEVENLABS_API_KEY", "offline-el-key");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await placeAgentCall(input("anonymous"));

    expect(res.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still places a +1 number, sent as to_number unchanged", async () => {
    vi.stubEnv("ELEVENLABS_LIVE", "live");
    vi.stubEnv("ELEVENLABS_API_KEY", "offline-el-key");
    const fetchSpy = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({
            success: true,
            conversation_id: "conv_1",
            callSid: "CA1",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await placeAgentCall(input("+12052598928"));

    expect(res).toEqual({
      ok: true,
      twilioCallSid: "CA1",
      conversationId: "conv_1",
    });
    const sent = JSON.parse(String(fetchSpy.mock.calls[0][1].body));
    expect(sent.to_number).toBe("+12052598928");
  });
});
