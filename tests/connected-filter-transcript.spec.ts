import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Two bug-fix contracts:
 *  - The Leads "Connected" filter (?connected=yes) shows leads that have at
 *    least one connected-outcome call, and hides leads that don't. (Regression:
 *    it resolved a giant id list whose URL the server rejected → showed nothing.)
 *  - The call detail transcript renders turns in time order (by
 *    time_in_call_secs), not raw payload order.
 */
test.describe("Connected filter + transcript order", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let connectedLeadId: string;
  let coldLeadId: string;
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
      .insert({ owner_id: ownerId, name: `E2E Conn List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const mkLead = async (suffix: string) => {
      const { data } = await admin
        .from("leads")
        .insert({
          owner_id: ownerId,
          list_id: listId,
          company: `E2E ${suffix} ${stamp}`,
          business_phone: `+1555${tail}${suffix === "Connected" ? "01" : "02"}`,
          status: "ready_to_call",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    connectedLeadId = await mkLead("Connected");
    coldLeadId = await mkLead("Cold");

    // Connected lead: a goal_met call (a connected outcome) with an out-of-time
    // transcript (user@1, agent@5, user@3 → should render user, user, agent).
    const { data: call } = await admin
      .from("calls")
      .insert({
        lead_id: connectedLeadId,
        owner_id: ownerId,
        direction: "outbound",
        status: "completed",
        outcome: "goal_met",
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

    // Cold lead: only a voicemail (NOT a connected outcome).
    await admin.from("calls").insert({
      lead_id: coldLeadId,
      owner_id: ownerId,
      direction: "outbound",
      status: "completed",
      outcome: "voicemail",
      duration_seconds: 8,
    });
  });

  test.afterAll(async () => {
    await admin
      .from("calls")
      .delete()
      .eq("lead_id", connectedLeadId ?? "");
    await admin
      .from("calls")
      .delete()
      .eq("lead_id", coldLeadId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", connectedLeadId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", coldLeadId ?? "");
    await admin
      .from("lists")
      .delete()
      .eq("id", listId ?? "");
  });

  test("Connected filter shows the connected lead, hides the cold one", async ({
    page,
  }) => {
    await page.goto(`/leads?connected=yes&list=${listId}`);
    await expect(
      page.getByText(`E2E Connected ${stamp}`, { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText(`E2E Cold ${stamp}`, { exact: false }),
    ).toHaveCount(0);
  });

  test("transcript renders in time order", async ({ page }) => {
    await page.goto(`/leads/${connectedLeadId}?call=${callId}`);
    // The three turn texts should appear in time order: first(1), second(3),
    // third(5) — even though the payload order was first, third, second.
    const body = await page
      .locator("body")
      .getByText(/ZZZ(first|second|third)/)
      .allInnerTexts();
    const order = body
      .join(" ")
      .match(/ZZZ(first|second|third)/g)
      ?.slice(0, 3);
    expect(order).toEqual(["ZZZfirst", "ZZZsecond", "ZZZthird"]);
  });

  test("filter API parity: /leads stays responsive with the filter on", async ({
    baseURL,
  }) => {
    // A lightweight smoke that the filtered page renders without erroring.
    const api = await playwrightRequest.newContext({ baseURL });
    const res = await api.get(`/leads?connected=yes&list=${listId}`);
    expect(res.status()).toBeLessThan(400);
    await api.dispose();
  });
});
