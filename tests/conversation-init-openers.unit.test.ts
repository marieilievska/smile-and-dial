import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      },
      ...(over.calls ?? []),
    ],
    callbacks: over.callbacks ?? [],
    lead_campaign_summaries: [
      { lead_id: "lead1", campaign_id: "camp1", ai_summary: NOTE },
    ],
    custom_field_defs: [],
    lead_custom_values: [],
  });
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

  it("a hang-up or a 'call me later' is not a conversation → COLD, and no time label", async () => {
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
    expect(vars.last_contact).toBe("");
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
  });
});

describe("the note handed to the agent", () => {
  it("dates it from the last REAL conversation, in calendar days — not from the last dial", async () => {
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
