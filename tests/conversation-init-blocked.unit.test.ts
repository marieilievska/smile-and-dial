import { afterEach, describe, expect, it, vi } from "vitest";

import { buildConversationInitData } from "@/lib/elevenlabs/conversation-init";

import { makeFakeDb } from "./helpers/fake-supabase";

/**
 * A blocked caller must never reach the agent.
 *
 * The whole point is that it costs nothing: the Twilio call is terminated at
 * the start of the conversation-init webhook, before an orphan Inbound lead or
 * a `calls` row exists, so there is no ElevenLabs conversation whose length the
 * caller controls. On 2026-09-11 one caller ran up ~124 minutes over 40 calls
 * to a single pool number, which had to be released to stop him.
 *
 * hangUpCall is a stand-in here — no test may reach Twilio.
 */
const hangUpCall = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, error: null as string | null })),
);
vi.mock("@/lib/twilio/hangup", () => ({ hangUpCall }));

const OUR_NUMBER = "+15109837276";
const TROLL = "+15109258221";

function seed() {
  const db = makeFakeDb({
    twilio_numbers: [
      { id: "num1", phone_number: OUR_NUMBER, attached_campaign_id: "camp1" },
    ],
    campaigns: [
      {
        id: "camp1",
        owner_id: "owner1",
        agent_id: "agentdb1",
        inbound_greeting: "Hello?",
        transfer_destination_phone: null,
      },
    ],
    leads: [],
    calls: [],
    callbacks: [],
    dnc_entries: [{ id: "d1", phone: TROLL, owner_id: "owner1" }],
    lead_campaign_summaries: [],
    custom_field_defs: [],
    lead_custom_values: [],
    system_events: [],
  });
  db.setRpc("get_or_create_inbound_list", "inbound-list-1");
  return db;
}

const body = (over: Partial<Record<string, string>> = {}) => ({
  caller_id: TROLL,
  agent_id: "agent_el_1",
  called_number: OUR_NUMBER,
  call_sid: "CA_troll",
  conversation_id: "conv_troll",
  ...over,
});

afterEach(() => {
  hangUpCall.mockClear();
});

describe("conversation-init — blocked caller", () => {
  it("hangs the call up and creates no lead, no call row", async () => {
    const db = seed();

    const res = await buildConversationInitData(body(), db.client);

    expect(hangUpCall).toHaveBeenCalledWith("CA_troll");
    expect(db.tables.calls).toHaveLength(0);
    expect(db.tables.leads).toHaveLength(0);
    expect(res.dynamic_variables.call_id).toBe("");
  });

  it("logs an inbound_blocked event against the campaign", async () => {
    const db = seed();

    await buildConversationInitData(body(), db.client);

    expect(db.tables.system_events).toHaveLength(1);
    expect(db.tables.system_events[0]).toMatchObject({
      kind: "inbound_blocked",
      ref_table: "campaigns",
      ref_id: "camp1",
    });
    expect(db.tables.system_events[0].payload).toMatchObject({
      caller: TROLL,
      called_number: OUR_NUMBER,
      call_sid: "CA_troll",
      hangup_ok: true,
    });
  });

  it("lets an ordinary caller straight through, untouched", async () => {
    const db = seed();

    const res = await buildConversationInitData(
      body({ caller_id: "+15715550000", call_sid: "CA_ok" }),
      db.client,
    );

    expect(hangUpCall).not.toHaveBeenCalled();
    expect(db.tables.calls).toHaveLength(1);
    expect(res.dynamic_variables.call_type).toBe("inbound");
    expect(res.dynamic_variables.call_id).toBe(db.tables.calls[0].id);
  });

  it("still records the block when the Twilio hangup fails", async () => {
    const db = seed();
    hangUpCall.mockResolvedValueOnce({ ok: false, error: "Twilio 404: gone" });

    await buildConversationInitData(body(), db.client);

    expect(db.tables.calls).toHaveLength(0);
    expect(db.tables.system_events[0].payload).toMatchObject({
      hangup_ok: false,
    });
  });
});
