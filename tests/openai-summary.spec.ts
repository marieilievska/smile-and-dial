import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { mergeLeadSummary, mockMerge } from "../src/lib/openai/summary-merger";

test.describe.configure({ mode: "serial" });

/**
 * OpenAI rolling summary merger (Step 39 / BUILD_PLAN §13).
 *
 * Coverage:
 *  - mockMerge produces the "we know X / we last left off Y" structure
 *  - mergeLeadSummary writes the new ai_summary onto the lead
 *  - Live mode is hard-gated behind OPENAI_LIVE — when unset, no API
 *    calls fire and the cost stays $0
 */
test.describe("OpenAI summary merger (mock)", () => {
  test.use({ storageState: "playwright/.auth/user.json" });

  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let leadId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    ownerId = owner!.id;

    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Summary List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Summary Lead ${stamp}`,
        business_phone: `+1333${tail}10`,
        timezone: "America/New_York",
        status: "ready_to_call",
        ai_summary: "we know we just imported them / we last left off n/a",
      })
      .select("id")
      .single();
    leadId = lead!.id;
  });

  test.afterAll(async () => {
    if (leadId) await admin.from("leads").delete().eq("id", leadId);
    if (listId) await admin.from("lists").delete().eq("id", listId);
  });

  test("mockMerge produces the 'we know X / we last left off Y' shape", () => {
    const merged = mockMerge(
      "we know they're a yoga studio / we last left off n/a",
      "Owner asked for a follow-up next week",
    );
    expect(merged.toLowerCase()).toContain("we know");
    expect(merged.toLowerCase()).toContain("we last left off");
  });

  test("mergeLeadSummary writes the new summary onto the lead", async () => {
    const result = await mergeLeadSummary({
      leadId,
      latestSummary: "Owner committed to a Thursday discovery call.",
    });
    expect(result.mode).toBe("mock");
    expect(result.cost).toBe(0);
    expect(result.newSummary).toBeTruthy();

    const { data: lead } = await admin
      .from("leads")
      .select("ai_summary")
      .eq("id", leadId)
      .single();
    expect(lead?.ai_summary).toContain("Thursday discovery call");
  });

  test("with no latest summary and no recent calls, nothing is written", async () => {
    // Wipe the existing ai_summary first so we can tell the difference.
    await admin.from("leads").update({ ai_summary: null }).eq("id", leadId);
    const result = await mergeLeadSummary({ leadId, latestSummary: null });
    expect(result.newSummary).toBeNull();
    expect(result.cost).toBe(0);
  });
});
