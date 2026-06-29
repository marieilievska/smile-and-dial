import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Two bug-fix contracts:
 *  - The Leads "Called" filter (?called=yes) shows leads that have at least one
 *    call attempt (any outcome), and hides leads with no calls. (Regression: it
 *    resolved a giant id list whose URL the server rejected → showed nothing.)
 *  - The call detail transcript renders turns in time order (by
 *    time_in_call_secs), not raw payload order.
 */
test.describe("Called filter + transcript order", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let calledLeadId: string;
  let noCallLeadId: string;
  let callId: string;

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
      .insert({ owner_id: ownerId, name: `E2E Called List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const mkLead = async (label: string, phoneTail: string) => {
      const { data } = await admin
        .from("leads")
        .insert({
          owner_id: ownerId,
          list_id: listId,
          company: `E2E ${label} ${stamp}`,
          business_phone: `+1555${tail}${phoneTail}`,
          status: "ready_to_call",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    calledLeadId = await mkLead("Called", "01");
    noCallLeadId = await mkLead("NoCall", "02");

    // Called lead: one outbound call (any outcome counts) with an out-of-time
    // transcript (user@1, agent@5, user@3 → should render user, user, agent).
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: calledLeadId,
        owner_id: ownerId,
        direction: "outbound",
        status: "completed",
        outcome: "voicemail",
        duration_seconds: 30,
        transcript_json: [
          { role: "user", message: "ZZZfirst", time_in_call_secs: 1 },
          { role: "agent", message: "ZZZthird", time_in_call_secs: 5 },
          { role: "user", message: "ZZZsecond", time_in_call_secs: 3 },
        ],
      })
      .select("id")
      .single();
    callId = call!.id;

    // noCall lead: zero calls → must be hidden by the "has ≥1 call" filter.
  });

  test.afterAll(async () => {
    await admin
      .from("calls")
      .delete()
      .eq("lead_id", calledLeadId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", calledLeadId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", noCallLeadId ?? "");
    await admin
      .from("lists")
      .delete()
      .eq("id", listId ?? "");
  });

  test("Called filter shows the called lead, hides the no-call one", async ({
    page,
  }) => {
    await page.goto(`/leads?called=yes&list=${listId}`);
    await expect(
      page.getByText(`E2E Called ${stamp}`, { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText(`E2E NoCall ${stamp}`, { exact: false }),
    ).toHaveCount(0);
  });

  test("transcript renders in time order", async ({ page }) => {
    await page.goto(`/leads/${calledLeadId}?call=${callId}`);
    // The three turn texts should appear in time order: first(1), second(3),
    // third(5) — even though the payload order was first, third, second.
    const texts = await page
      .locator("body")
      .getByText(/ZZZ(first|second|third)/)
      .allInnerTexts();
    const order = texts
      .join(" ")
      .match(/ZZZ(first|second|third)/g)
      ?.slice(0, 3);
    expect(order).toEqual(["ZZZfirst", "ZZZsecond", "ZZZthird"]);
  });

  test("filtered Leads page stays responsive", async ({ baseURL }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const res = await api.get(`/leads?called=yes&list=${listId}`);
    expect(res.status()).toBeLessThan(400);
    await api.dispose();
  });
});
