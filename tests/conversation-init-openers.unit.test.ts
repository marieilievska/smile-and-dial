import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_OUTCOMES,
  NO_HUMAN_OUTCOMES,
  OVERRIDABLE_OUTCOMES,
  REACHED_HUMAN_OUTCOMES,
} from "@/lib/calls/outcomes";
import {
  buildCallDynamicVariables,
  buildConversationInitData,
} from "@/lib/elevenlabs/conversation-init";

import { makeFakeDb } from "./helpers/fake-supabase";

/**
 * How conversation-init picks a call's opener and dates the note it hands the
 * agent (spec: 2026-09-12 callback-openers). Offline: an in-memory stand-in
 * for Supabase and a frozen clock — Saturday 2026-09-12, 10:00 AM in Chicago,
 * where the lead is.
 */
const NOW = new Date("2026-09-12T15:00:00Z");
const YESTERDAY_5PM = "2026-09-11T22:00:00Z"; // Fri 5:00 PM CDT, 17 hours before NOW
const WEDNESDAY = "2026-09-09T15:00:00Z"; // Wed 10:00 AM CDT
const THIS_MORNING = "2026-09-12T13:00:00Z"; // Sat 8:00 AM CDT

const NOTE = [
  "Status: Gatekeeper — owner not reached yet",
  "Left off: Call back tomorrow after 1:30.",
  "Known — don't re-ask:",
  "  • Uses Vagaro.",
].join("\n");

type Row = Record<string, unknown>;

function seed(over: { calls?: Row[]; callbacks?: Row[]; campaign?: Row } = {}) {
  return makeFakeDb({
    leads: [
      {
        id: "lead1",
        company: "Bodhi's Gym Nest",
        status: "ready_to_call",
        owner_name: null,
        manager_name: null,
        employee_name: null,
        city: "Plano",
        category: "gym",
        google_rating: 4.7,
        google_reviews: 88,
        timezone: "America/Chicago",
        // Every dial stamps this; here it's a voicemail this morning. The
        // note's time label must not count it.
        last_call_at: THIS_MORNING,
      },
    ],
    campaigns: [
      {
        id: "camp1",
        transfer_destination_phone: null,
        callback_opener: null,
        spoken_before_opener: null,
        ...over.campaign,
      },
    ],
    calls: [
      // The call being placed right now — no outcome yet.
      {
        id: "call-now",
        lead_id: "lead1",
        campaign_id: "camp1",
        outcome: null,
        started_at: NOW.toISOString(),
        created_at: NOW.toISOString(),
      },
      // A row's created_at defaults to its started_at (the dialer inserts the
      // row just before it stamps started_at); a test can override either.
      ...(over.calls ?? []).map((c) => ({ created_at: c.started_at, ...c })),
    ],
    callbacks: over.callbacks ?? [],
    lead_campaign_summaries: [
      { lead_id: "lead1", campaign_id: "camp1", ai_summary: NOTE },
    ],
    custom_field_defs: [],
    lead_custom_values: [],
  });
}

/** The fake client, except any `select` on `table` that names `column` fails
 *  the way PostgREST does when that column doesn't exist (e.g. before a
 *  migration). Every other query goes to the in-memory stand-in untouched. */
function withMissingColumn(client: unknown, table: string, column: string) {
  const failure = {
    data: null,
    error: { message: `column ${table}.${column} does not exist` },
  };
  const failing: object = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then") {
          return (
            resolve: (value: typeof failure) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => Promise.resolve(failure).then(resolve, reject);
        }
        if (prop === "maybeSingle" || prop === "single") {
          return async () => failure;
        }
        return () => failing;
      },
    },
  );
  const inner = client as {
    from: (name: string) => { select: (columns: string) => unknown };
    rpc: unknown;
  };
  return {
    from: (name: string) => {
      const builder = inner.from(name);
      if (name !== table) return builder;
      return new Proxy(builder, {
        get: (target, prop, receiver) =>
          prop === "select"
            ? (columns: string) =>
                columns.includes(column) ? failing : target.select(columns)
            : Reflect.get(target, prop, receiver),
      });
    },
    rpc: inner.rpc,
  } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("opening_instruction — which opener a call gets", () => {
  it("a callback booked in this campaign → CALLBACK with the default line, dated from the call that booked it", async () => {
    const db = seed({
      calls: [
        {
          id: "call-booked",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "callback",
          started_at: YESTERDAY_5PM,
          callback_notes: "Janie said to try after 1:30.",
          summary: null,
        },
        {
          id: "call-vm",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "voicemail",
          started_at: THIS_MORNING,
        },
      ],
      callbacks: [
        {
          id: "cb1",
          lead_id: "lead1",
          campaign_id: "camp1",
          status: "pending",
          originating_call_id: "call-booked",
          scheduled_at: "2026-09-12T18:30:00Z",
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.opening_instruction).toBe(
      'CALLBACK: we agreed to call this business back. Wait for them to answer, then your first reply must be exactly: "Hey there, um, I called yesterday and was told to try back around this time for the owner or manager. Are they around?" Never use the cold opener on this call, however they answer the phone.',
    );
    expect(vars.call_type).toBe("callback");
    expect(vars.last_callback_notes).toBe("Janie said to try after 1:30.");
  });

  it("a past conversation and no callback → FOLLOW-UP with the campaign's own line", async () => {
    const db = seed({
      campaign: {
        spoken_before_opener:
          "Hey there, Tom here, um, I reached out {when}. Is the owner around?",
      },
      calls: [
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: WEDNESDAY,
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.opening_instruction).toBe(
      'FOLLOW-UP: we have spoken with this business before and no callback is booked. Wait for them to answer, then your first reply must be exactly: "Hey there, Tom here, um, I reached out on Wednesday. Is the owner around?" Never use the cold opener on this call, however they answer the phone.',
    );
    expect(vars.call_type).toBe("cold");
  });

  it("a hang-up or a 'call me later' is not a conversation → COLD, though the 'call me later' still dates the note", async () => {
    const db = seed({
      calls: [
        {
          id: "call-hangup",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "hung_up_immediately",
          started_at: YESTERDAY_5PM,
        },
        {
          id: "call-later",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "call_back_later",
          started_at: WEDNESDAY,
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.opening_instruction).toBe(
      "COLD CALL: this is our first real conversation with this business. Use the cold opener below.",
    );
    // We reached a person on Wednesday (a call that can rewrite the note); the
    // hang-up yesterday doesn't count.
    expect(vars.last_contact).toBe("on Wednesday");
  });

  it("a conversation under another campaign doesn't count → COLD", async () => {
    const db = seed({
      calls: [
        {
          id: "call-other",
          lead_id: "lead1",
          campaign_id: "camp2",
          outcome: "gatekeeper",
          started_at: YESTERDAY_5PM,
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.opening_instruction).toMatch(/^COLD CALL:/);
  });

  it("a callback booked under another campaign doesn't make this call a CALLBACK", async () => {
    const db = seed({
      calls: [
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: WEDNESDAY,
        },
        {
          id: "call-other",
          lead_id: "lead1",
          campaign_id: "camp2",
          outcome: "callback",
          started_at: YESTERDAY_5PM,
          callback_notes: "Other campaign's note.",
        },
      ],
      callbacks: [
        {
          id: "cb-other",
          lead_id: "lead1",
          campaign_id: "camp2",
          status: "pending",
          originating_call_id: "call-other",
          scheduled_at: "2026-09-12T16:00:00Z",
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.opening_instruction).toMatch(/^FOLLOW-UP:/);
    expect(vars.last_callback_notes).toBe("");
    // call_type still reflects ANY pending callback (the prompt's procedures
    // read it); only the opener and the notes are per-campaign.
    expect(vars.call_type).toBe("callback");
  });

  it("a callback booked on Wednesday, then a 'call me later' yesterday → CALLBACK dated from the booking call; the note dated yesterday", async () => {
    const db = seed({
      calls: [
        {
          id: "call-booked",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "callback",
          started_at: WEDNESDAY,
          callback_notes: "Owner is in after 2.",
        },
        {
          id: "call-later",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "call_back_later",
          started_at: YESTERDAY_5PM,
        },
      ],
      callbacks: [
        {
          id: "cb1",
          lead_id: "lead1",
          campaign_id: "camp1",
          status: "pending",
          originating_call_id: "call-booked",
          scheduled_at: "2026-09-12T18:30:00Z",
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.opening_instruction).toContain(
      '"Hey there, um, I called on Wednesday and was told to try back around this time for the owner or manager. Are they around?"',
    );
    expect(vars.last_contact).toBe("yesterday");
    expect(
      vars.last_call_summary.startsWith(
        "(Our last call with them was yesterday.)",
      ),
    ).toBe(true);
  });

  it("a real conversation, then a 'call me later' yesterday, no callback → FOLLOW-UP that says yesterday", async () => {
    const db = seed({
      calls: [
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: WEDNESDAY,
        },
        {
          id: "call-later",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "call_back_later",
          started_at: YESTERDAY_5PM,
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.opening_instruction).toBe(
      'FOLLOW-UP: we have spoken with this business before and no callback is booked. Wait for them to answer, then your first reply must be exactly: "Hey there, um, I reached out yesterday and wanted to check back in. Is the owner or manager around?" Never use the cold opener on this call, however they answer the phone.',
    );
    expect(vars.last_contact).toBe("yesterday");
  });

  it("uses the campaign's own callback line when it has one", async () => {
    const db = seed({
      campaign: {
        callback_opener:
          "Hi, it's Tom again. I called {when} and they said to try back now. Is the owner in?",
      },
      calls: [
        {
          id: "call-booked",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "callback",
          started_at: YESTERDAY_5PM,
        },
      ],
      callbacks: [
        {
          id: "cb1",
          lead_id: "lead1",
          campaign_id: "camp1",
          status: "pending",
          originating_call_id: "call-booked",
          scheduled_at: "2026-09-12T18:30:00Z",
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.opening_instruction).toBe(
      'CALLBACK: we agreed to call this business back. Wait for them to answer, then your first reply must be exactly: "Hi, it\'s Tom again. I called yesterday and they said to try back now. Is the owner in?" Never use the cold opener on this call, however they answer the phone.',
    );
  });

  it("a pending callback with no booking call on record → CALLBACK dated from the last call where we reached a person", async () => {
    const db = seed({
      calls: [
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: WEDNESDAY,
        },
        {
          id: "call-dnc",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "dnc",
          started_at: YESTERDAY_5PM,
        },
      ],
      callbacks: [
        {
          id: "cb1",
          lead_id: "lead1",
          campaign_id: "camp1",
          status: "pending",
          originating_call_id: null,
          scheduled_at: "2026-09-12T18:30:00Z",
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.opening_instruction).toContain(
      '"Hey there, um, I called yesterday and was told to try back around this time for the owner or manager. Are they around?"',
    );
    expect(vars.last_callback_notes).toBe("");
  });

  it("a real conversation whose start time was never stamped still counts, dated by when its row was created", async () => {
    const db = seed({
      calls: [
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: null,
          created_at: WEDNESDAY,
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.opening_instruction).toMatch(
      /^FOLLOW-UP: .*I reached out on Wednesday/,
    );
    expect(vars.last_contact).toBe("on Wednesday");
  });

  it("opener columns unavailable (e.g. before the migration) → the transfer number still arrives, the default line is used, and the failure is logged", async () => {
    const db = seed({
      campaign: {
        transfer_destination_phone: "+15125550100",
        spoken_before_opener: "Custom line {when}.",
      },
      calls: [
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: WEDNESDAY,
        },
      ],
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const vars = await buildCallDynamicVariables(
      withMissingColumn(db.client, "campaigns", "callback_opener"),
      "call-now",
    );

    expect(vars.transfer_number).toBe("+15125550100");
    expect(vars.opening_instruction).toContain(
      '"Hey there, um, I reached out on Wednesday and wanted to check back in. Is the owner or manager around?"',
    );
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("[conversation-init]"),
    );
    errors.mockRestore();
  });

  it("orders calls by when their row was created — a newer call whose start was never stamped still wins", async () => {
    const db = seed({
      calls: [
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: WEDNESDAY,
        },
        {
          id: "call-gk2",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: null,
          created_at: YESTERDAY_5PM,
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.last_contact).toBe("yesterday");
    expect(vars.opening_instruction).toMatch(
      /^FOLLOW-UP: .*I reached out yesterday/,
    );
  });

  it("a lead marked callback with nothing booked in this campaign → call_type stays callback, the opener is FOLLOW-UP and the Left off line is dropped", async () => {
    const db = seed({
      calls: [
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: WEDNESDAY,
        },
      ],
    });
    db.tables.leads[0].status = "callback";

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.call_type).toBe("callback");
    expect(vars.opening_instruction).toMatch(/^FOLLOW-UP:/);
    expect(vars.last_call_summary).not.toContain("Left off:");
  });

  it("a call with no campaign → COLD with no campaign context, and nothing logged", async () => {
    const db = seed({
      calls: [
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: WEDNESDAY,
        },
      ],
    });
    db.tables.calls[0].campaign_id = null; // the call being placed
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.opening_instruction).toMatch(/^COLD CALL:/);
    expect(vars.last_contact).toBe("");
    expect(vars.last_call_summary).toBe("");
    expect(vars.transfer_number).toBe("");
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("a lead with a timezone Intl doesn't know still gets today's date (Eastern) instead of failing the dial", async () => {
    const db = seed();
    db.tables.leads[0].timezone = "Mars/Olympus";

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.current_date).toBe("Saturday, September 12, 2026");
  });
});

describe("the note handed to the agent", () => {
  it("dates it from the last call where we reached a person, in calendar days — not from the last dial", async () => {
    // A gatekeeper at 5 PM yesterday, then a voicemail this morning (which also
    // stamped leads.last_call_at). The old label said "earlier today".
    const db = seed({
      calls: [
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: YESTERDAY_5PM,
        },
        {
          id: "call-vm",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "voicemail",
          started_at: THIS_MORNING,
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.last_contact).toBe("yesterday");
    expect(
      vars.last_call_summary.startsWith(
        "(Our last call with them was yesterday.) Status:",
      ),
    ).toBe(true);
  });

  it("drops the Left off line when no callback is booked in this campaign", async () => {
    const db = seed({
      calls: [
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: WEDNESDAY,
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.last_call_summary).not.toContain("Left off:");
    expect(vars.last_call_summary).toContain("  • Uses Vagaro.");
  });

  it("keeps the Left off line while a callback is booked in this campaign", async () => {
    const db = seed({
      calls: [
        {
          id: "call-booked",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "callback",
          started_at: YESTERDAY_5PM,
        },
      ],
      callbacks: [
        {
          id: "cb1",
          lead_id: "lead1",
          campaign_id: "camp1",
          status: "pending",
          originating_call_id: "call-booked",
          scheduled_at: "2026-09-12T18:30:00Z",
        },
      ],
    });

    const vars = await buildCallDynamicVariables(db.client, "call-now");

    expect(vars.last_call_summary).toContain(
      "Left off: Call back tomorrow after 1:30.",
    );
  });
});

describe("the inbound webhook", () => {
  it("opens a call it can't match as INBOUND — only inbound calls reach this webhook", async () => {
    const db = makeFakeDb();

    const res = await buildConversationInitData(
      {
        caller_id: "+15718007365",
        called_number: "+15715639384",
        conversation_id: "conv_unmatched",
      },
      db.client,
    );

    expect(res.dynamic_variables.opening_instruction).toBe(
      "INBOUND CALL: they are calling us back. Use the inbound opener below.",
    );
  });

  it("a repeat init for an inbound call we already recorded still opens as INBOUND", async () => {
    // The first init created this row (direction "inbound", CallSid stamped).
    // A second init for the same call finds it by CallSid and must not fall
    // back to the outbound situations — this lead has a past conversation, so
    // that would be FOLLOW-UP.
    const db = seed({
      calls: [
        {
          id: "call-in",
          lead_id: "lead1",
          campaign_id: "camp1",
          direction: "inbound",
          twilio_call_sid: "CA-inbound-1",
          outcome: null,
          started_at: THIS_MORNING,
        },
        {
          id: "call-gk",
          lead_id: "lead1",
          campaign_id: "camp1",
          outcome: "gatekeeper",
          started_at: WEDNESDAY,
        },
      ],
    });

    const res = await buildConversationInitData(
      {
        caller_id: "+12145550100",
        called_number: "+14695550100",
        call_sid: "CA-inbound-1",
        conversation_id: "conv_repeat",
      },
      db.client,
    );

    expect(res.dynamic_variables.call_id).toBe("call-in");
    expect(res.dynamic_variables.call_type).toBe("inbound");
    expect(res.dynamic_variables.opening_instruction).toBe(
      "INBOUND CALL: they are calling us back. Use the inbound opener below.",
    );
  });
});

describe("REACHED_HUMAN_OUTCOMES", () => {
  it("is exactly classifyCallOutcome's reachedHuman rule: not a hang-up, not a machine or no-pickup", () => {
    const every = new Set<string>([...OVERRIDABLE_OUTCOMES, "call_back_later"]);
    for (const outcome of every) {
      const reachedHuman =
        outcome !== "hung_up_immediately" &&
        outcome !== "hung_up_later" &&
        !NO_HUMAN_OUTCOMES.has(outcome);
      expect(REACHED_HUMAN_OUTCOMES.has(outcome), outcome).toBe(reachedHuman);
    }
  });

  it("holds every real conversation plus the 'call me later' brush-off", () => {
    for (const outcome of CONVERSATION_OUTCOMES) {
      expect(REACHED_HUMAN_OUTCOMES.has(outcome), outcome).toBe(true);
    }
    expect(REACHED_HUMAN_OUTCOMES.has("call_back_later")).toBe(true);
  });
});
