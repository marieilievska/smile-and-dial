import { describe, expect, it } from "vitest";

import { buildConversationInitData } from "@/lib/elevenlabs/conversation-init";

import { makeFakeDb } from "./helpers/fake-supabase";

/**
 * EL-native INBOUND: someone returns our missed call. ElevenLabs asks the init
 * webhook for context with { caller_id, called_number, call_sid,
 * conversation_id } — and at that moment NO `calls` row exists yet (the
 * post-call webhook used to be the first to create it). The webhook must
 * still hand the agent the lead's context, call_type "inbound", and a real
 * call_id so the in-call tools (callback / booking / DNC) can resolve the lead.
 */
const OUR_NUMBER = "+15715639384";
const CALLER = "+15718007365";

function seed() {
  const twentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString();
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
    leads: [
      {
        id: "lead1",
        owner_id: "owner1",
        company: "Gaia Spa - Arlington",
        business_phone: CALLER,
        mobile_phone: null,
        owner_phone: null,
        deleted_at: null,
        owner_name: "Adian",
        manager_name: null,
        employee_name: null,
        city: "Arlington",
        category: "spa",
        google_rating: 4.8,
        google_reviews: 120,
        timezone: "America/New_York",
        last_call_at: twentyMinAgo,
        status: "ready_to_call",
      },
    ],
    calls: [],
    callbacks: [],
    lead_campaign_summaries: [],
    custom_field_defs: [],
    lead_custom_values: [],
  });
  db.setRpc("get_or_create_inbound_list", "inbound-list-1");
  return db;
}

const inboundBody = (over: Partial<Record<string, string>> = {}) => ({
  caller_id: CALLER,
  agent_id: "agent_el_1",
  called_number: OUR_NUMBER,
  call_sid: "CA123",
  conversation_id: "conv_1",
  ...over,
});

describe("conversation-init — inbound (returned missed call)", () => {
  it("resolves the caller to their lead and hands the agent inbound context", async () => {
    const db = seed();
    const res = await buildConversationInitData(inboundBody(), db.client);

    expect(res.dynamic_variables.call_type).toBe("inbound");
    expect(res.dynamic_variables.business_name).toBe("Gaia Spa - Arlington");
    expect(res.dynamic_variables.owner_name).toBe("Adian");
    expect(res.dynamic_variables.lead_timezone).toBe("America/New_York");
    expect(res.conversation_config_override?.agent.first_message).toBe(
      "Hello?",
    );
  });

  it("creates the inbound calls row up front and binds its id as call_id for the tools", async () => {
    const db = seed();
    const res = await buildConversationInitData(inboundBody(), db.client);

    expect(db.tables.calls).toHaveLength(1);
    const call = db.tables.calls[0];
    expect(call).toMatchObject({
      direction: "inbound",
      twilio_call_sid: "CA123",
      elevenlabs_conversation_id: "conv_1",
      lead_id: "lead1",
      campaign_id: "camp1",
      agent_id: "agentdb1",
      twilio_number_id: "num1",
      status: "in_progress",
    });
    expect(res.dynamic_variables.call_id).toBe(call.id);
  });

  it("is idempotent: a second init for the same call_sid reuses the row", async () => {
    const db = seed();
    const a = await buildConversationInitData(inboundBody(), db.client);
    const b = await buildConversationInitData(inboundBody(), db.client);
    expect(db.tables.calls).toHaveLength(1);
    expect(b.dynamic_variables.call_id).toBe(a.dynamic_variables.call_id);
  });

  it("a caller we don't know gets a new lead in the owner's Inbound list, still with a working call_id", async () => {
    const db = seed();
    const res = await buildConversationInitData(
      inboundBody({ caller_id: "+16788868385" }),
      db.client,
    );

    expect(res.dynamic_variables.call_type).toBe("inbound");
    expect(db.rpcCalls).toEqual([
      { fn: "get_or_create_inbound_list", args: { in_owner: "owner1" } },
    ]);
    const newLead = db.tables.leads.find(
      (l) => l.business_phone === "+16788868385",
    );
    expect(newLead).toMatchObject({
      owner_id: "owner1",
      list_id: "inbound-list-1",
    });
    expect(db.tables.calls[0]).toMatchObject({ lead_id: newLead?.id });
    expect(res.dynamic_variables.call_id).toBe(db.tables.calls[0].id);
  });

  it("matches a caller by mobile/owner phone too (merged inbound leads park the number there)", async () => {
    const db = seed();
    db.tables.leads[0].mobile_phone = "+17035550000";
    const res = await buildConversationInitData(
      inboundBody({ caller_id: "+17035550000" }),
      db.client,
    );
    expect(db.tables.calls[0]).toMatchObject({ lead_id: "lead1" });
    expect(res.dynamic_variables.business_name).toBe("Gaia Spa - Arlington");
  });

  it("leaves a call the dialer already stamped alone (outbound-shaped init): no inbound row, cold context", async () => {
    const db = seed();
    // called_number is the LEAD's number here, not one of ours.
    const res = await buildConversationInitData(
      {
        caller_id: OUR_NUMBER,
        agent_id: "agent_el_1",
        called_number: "+12025550123",
        call_sid: "CA-unknown",
        conversation_id: "conv_2",
      },
      db.client,
    );
    expect(res.dynamic_variables.call_type).toBe("cold");
    expect(res.dynamic_variables.call_id).toBe("");
    expect(db.tables.calls).toHaveLength(0);
  });
});
