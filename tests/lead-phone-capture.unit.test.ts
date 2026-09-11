import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every phone number a PERSON gives us is stored the same way: E.164, or not
 * at all. Two places take one:
 *
 *   - the lead page, where someone types it (updateLeadField). Only
 *     business_phone was normalized; owner_phone went in exactly as typed,
 *     so "(205) 259-8928" was stored in a form the dialer now refuses (#532)
 *     and the DNC list, which holds E.164, could never match.
 *   - a call, where the agent hears one and send_text stores it. Its own
 *     normalizer prefixed "+" onto anything, so a foreign cell or half of a
 *     misheard one was saved on the lead — and then used as the Calendly
 *     booking phone, matched against inbound texts, and texted again later.
 *
 * These run the REAL server action and the REAL tool webhook against an
 * offline PostgREST stand-in (https://offline.invalid never resolves; a
 * stubbed global fetch answers and records every request), so nothing here
 * can reach production, send a text, or place a call.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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

import { executeServerTool } from "@/lib/elevenlabs/tool-webhook";
import { updateLeadField } from "@/lib/leads/lead-actions";

const LEAD = "1ead0000-0000-4000-8000-000000000001";
const CALL = "ca110000-0000-4000-8000-000000000001";
const CAMPAIGN = "c0000000-0000-4000-8000-000000000001";

type Recorded = {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Record<string, unknown>;
};

/** An offline PostgREST that records every request. Reads answer with rows
 *  (an object when the client asked for exactly one); writes succeed. */
function standIn(lead: Record<string, unknown> = {}) {
  const requests: Recorded[] = [];
  const leadRow = {
    id: LEAD,
    owner_id: "user-1",
    company: "Test Gym",
    business_phone: "+12052598928",
    mobile_phone: null,
    owner_phone: null,
    business_email: null,
    city: null,
    state: null,
    website: null,
    owner_name: null,
    manager_name: null,
    employee_name: null,
    timezone: "America/New_York",
    status: "ready_to_call",
    ...lead,
  };
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
      const table = url.pathname.replace(/^\/rest\/v1\//, "");

      if (url.pathname.startsWith("/rest/v1/rpc/")) return json(null);
      if (method === "GET") {
        if (table === "calls") {
          const row = { id: CALL, lead_id: LEAD, campaign_id: CAMPAIGN };
          return json(one ? row : [row]);
        }
        if (table === "leads") return json(one ? leadRow : [leadRow]);
        return json(one ? null : []);
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

const leadPatches = (reqs: Recorded[]) =>
  reqs.filter((r) => r.method === "PATCH" && r.path === "/rest/v1/leads");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://offline.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "offline-service-key");
  vi.stubEnv("ELEVENLABS_LIVE", "");
  vi.stubEnv("CLOSE_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("editing a phone on the lead page stores E.164 or nothing", () => {
  it.each([
    ["the owner's phone", "owner_phone"],
    ["the business phone", "business_phone"],
  ])(
    "%s typed as (205) 259-8928 is stored +12052598928",
    async (_what, field) => {
      const db = standIn();
      vi.stubGlobal("fetch", db.fetchStub);

      const res = await updateLeadField({
        leadId: LEAD,
        field,
        value: "(205) 259-8928",
      });

      expect(res.error).toBeNull();
      expect(leadPatches(db.requests).map((r) => r.body)).toEqual([
        { [field]: "+12052598928" },
      ]);
    },
  );

  it.each([
    ["a foreign number", "+44 20 7946 0958"],
    ["a misheard number nobody has", "111-111-1111"],
    ["a word", "anonymous"],
  ])(
    "refuses %s on the owner's phone and stores nothing",
    async (_what, typed) => {
      const db = standIn();
      vi.stubGlobal("fetch", db.fetchStub);

      const res = await updateLeadField({
        leadId: LEAD,
        field: "owner_phone",
        value: typed,
      });

      expect(res.error).toBe("Enter a valid US/Canada phone number.");
      expect(leadPatches(db.requests)).toHaveLength(0);
    },
  );

  it("clearing the owner's phone is still allowed", async () => {
    const db = standIn();
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await updateLeadField({
      leadId: LEAD,
      field: "owner_phone",
      value: "   ",
    });

    expect(res.error).toBeNull();
    expect(leadPatches(db.requests).map((r) => r.body)).toEqual([
      { owner_phone: null },
    ]);
  });

  it("leaves a field that isn't a phone alone", async () => {
    const db = standIn();
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await updateLeadField({
      leadId: LEAD,
      field: "city",
      value: "  Boise  ",
    });

    expect(res.error).toBeNull();
    expect(leadPatches(db.requests).map((r) => r.body)).toEqual([
      { city: "Boise" },
    ]);
  });

  it("the mobile phone is not editable by hand today", async () => {
    // Pinned deliberately: the AI sets mobile_phone from a call. If this field
    // is ever added to the lead page, this test fails — and the rule above
    // already covers it, so the fix is to update this expectation.
    const db = standIn();
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await updateLeadField({
      leadId: LEAD,
      field: "mobile_phone",
      value: "(205) 259-8928",
    });

    expect(res.error).toBe("That field cannot be edited.");
    expect(leadPatches(db.requests)).toHaveLength(0);
  });
});

describe("a cell the agent hears is stored E.164 or not at all", () => {
  const sendText = (mobile: string) =>
    executeServerTool("send_text", {
      call_id: CALL,
      mobile,
      note: "sending the link",
    });

  it("a real cell, said in any form, is stored as +1 and ten digits", async () => {
    const db = standIn();
    vi.stubGlobal("fetch", db.fetchStub);

    await sendText("(205) 259-8928");

    expect(leadPatches(db.requests).map((r) => r.body)).toEqual([
      { mobile_phone: "+12052598928" },
    ]);
  });

  it.each([
    ["a foreign cell", "+44 20 7946 0958"],
    ["a misheard number nobody has", "111-111-1111"],
    ["half a number", "205-259"],
  ])(
    "%s (%s) is never stored, and the agent asks again",
    async (_what, said) => {
      const db = standIn();
      vi.stubGlobal("fetch", db.fetchStub);

      const res = await sendText(said);

      expect(res.success).toBe(false);
      expect(res.message).toMatch(/best cell number/);
      expect(leadPatches(db.requests)).toHaveLength(0);
    },
  );

  it("a bad number already on the lead is not texted either", async () => {
    // A foreign cell stored by the old rule. Nothing re-checked it, so it was
    // used for every later text and as the Calendly booking phone.
    const db = standIn({ mobile_phone: "+442079460958" });
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await sendText("");

    expect(res.success).toBe(false);
    expect(res.message).toMatch(/best cell number/);
  });

  it("a stored cell in an older format is used, and tidied up", async () => {
    const db = standIn({ mobile_phone: "(205) 259-8928" });
    vi.stubGlobal("fetch", db.fetchStub);

    await sendText("");

    expect(leadPatches(db.requests).map((r) => r.body)).toEqual([
      { mobile_phone: "+12052598928" },
    ]);
  });
});
