import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Calendly integration (Step 37 / BUILD_PLAN §11).
 *
 * Coverage:
 *  - Admin can connect Calendly (mock) and the card flips to "Connected"
 *  - invitee.created webhook matches an existing lead by email and flips
 *    its status to `scheduled`, with a calendly_events row written
 *  - invitee.canceled flips the calendly_events status to canceled
 */
test.describe.configure({ mode: "serial" });

test.describe("Calendly integration", () => {
  test.use({ storageState: "playwright/.auth/user.json" });

  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let leadId: string;
  const inviteeUri = `https://api.calendly.com/scheduled_events/${stamp}/invitees/abc`;

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
      .insert({ owner_id: ownerId, name: `E2E Calendly List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Calendly Lead ${stamp}`,
        business_phone: `+1555${tail}11`,
        business_email: `e2e-calendly-${stamp}@example.com`,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadId = lead!.id;
  });

  test.afterAll(async () => {
    await admin.from("calendly_events").delete().eq("invitee_uri", inviteeUri);
    await admin.from("notifications").delete().eq("ref_id", leadId);
    if (leadId) await admin.from("leads").delete().eq("id", leadId);
    if (listId) await admin.from("lists").delete().eq("id", listId);
    // Per-user integrations: clear the test user's connection row.
    await admin.from("user_integrations").delete().eq("user_id", ownerId);
  });

  test("the Calendly card is per-user: paste-to-connect, seed + disconnect", async ({
    page,
  }) => {
    // Not connected → the per-user paste-token UI is shown.
    await page.goto("/settings/integrations");
    await expect(page.getByTestId("calendly-token")).toBeVisible();
    await expect(page.getByTestId("calendly-connect")).toBeVisible();

    // Seed this user's connection directly (avoids a live Calendly call), then
    // verify the connected UI renders and Disconnect clears the row.
    const nowIso = new Date().toISOString();
    await admin.from("user_integrations").upsert(
      {
        user_id: ownerId,
        calendly_api_key: "seeded-token",
        calendly_organization_uri:
          "https://api.calendly.com/organizations/seed",
        calendly_connected_at: nowIso,
        calendly_last_sync_at: nowIso,
      },
      { onConflict: "user_id" },
    );

    await page.reload();
    await expect(page.getByTestId("calendly-disconnect")).toBeVisible();
    await page.getByTestId("calendly-disconnect").click();
    await expect(page.getByTestId("calendly-connect")).toBeVisible({
      timeout: 5000,
    });

    const { data: integ } = await admin
      .from("user_integrations")
      .select("calendly_connected_at")
      .eq("user_id", ownerId)
      .maybeSingle();
    expect(integ?.calendly_connected_at).toBeNull();
  });

  test("invitee.created webhook matches by email and flips lead to scheduled", async ({
    baseURL,
  }) => {
    const apiContext = await playwrightRequest.newContext({ baseURL });
    const startTime = new Date(Date.now() + 86_400_000).toISOString();
    const res = await apiContext.post("/api/calendly/webhook", {
      data: {
        event: "invitee.created",
        payload: {
          uri: inviteeUri,
          email: `e2e-calendly-${stamp}@example.com`,
          name: "E2E Calendly Invitee",
          text_reminder_number: null,
          cancel_url: "https://calendly.com/cancellations/abc",
          reschedule_url: "https://calendly.com/reschedulings/abc",
          scheduled_event: {
            uri: `https://api.calendly.com/scheduled_events/${stamp}`,
            start_time: startTime,
            event_type: "https://api.calendly.com/event_types/mock-discovery",
          },
        },
      },
    });
    expect(res.status()).toBe(200);

    const { data: lead } = await admin
      .from("leads")
      .select("status, calendly_event_uri")
      .eq("id", leadId)
      .single();
    expect(lead?.status).toBe("scheduled");
    expect(lead?.calendly_event_uri).toContain(`scheduled_events/${stamp}`);

    const { data: events } = await admin
      .from("calendly_events")
      .select("id, lead_id, status")
      .eq("invitee_uri", inviteeUri);
    expect((events ?? []).length).toBe(1);
    expect(events![0].lead_id).toBe(leadId);
    expect(events![0].status).toBe("scheduled");
  });

  test("invitee.canceled webhook flips the calendly_event status", async ({
    baseURL,
  }) => {
    const apiContext = await playwrightRequest.newContext({ baseURL });
    const res = await apiContext.post("/api/calendly/webhook", {
      data: {
        event: "invitee.canceled",
        payload: {
          uri: inviteeUri,
          email: `e2e-calendly-${stamp}@example.com`,
          scheduled_event: {
            uri: `https://api.calendly.com/scheduled_events/${stamp}`,
          },
        },
      },
    });
    expect(res.status()).toBe(200);

    const { data: events } = await admin
      .from("calendly_events")
      .select("status")
      .eq("invitee_uri", inviteeUri);
    expect(events?.[0].status).toBe("canceled");
  });
});
