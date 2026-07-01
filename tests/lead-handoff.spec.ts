import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Relative import (not the `@/` alias): keeps the pure helper resolvable under
// Playwright's loader, matching how the other specs import. buildHandoffNote has
// no server-only/Next imports, so pulling it into a test is safe.
import { buildHandoffNote } from "../src/lib/close/handoff";

test.describe("buildHandoffNote", () => {
  test("renders appointment (lead tz), summary, key answers, recording", () => {
    const note = buildHandoffNote({
      lead: {
        company: "Aqua-Tots Lone Tree",
        ownerName: null,
        managerName: "Liam",
        employeeName: "Danica",
        businessPhone: "+13037311363",
        businessEmail: "info@aqua-tots.com",
        timezone: "America/Denver",
        city: "Lone Tree",
        state: "CO",
      },
      call: {
        summary: "Booked a demo with Liam.",
        disposition: "goal_met",
        leadResponseTime: "within 10 minutes",
        decisionMakerReached: "no",
        startedAt: "2026-06-30T22:00:37.910Z",
        recordingUrl: "https://elevenlabs.io/app/agents/agents/A/history/C",
      },
      appointment: {
        scheduledAt: "2026-07-01T16:30:00.000Z", // 10:30 AM Mountain
        eventLink: null,
      },
      customFields: [{ label: "Current AI tools", value: "None" }],
    });

    expect(note).toContain("WHO TO MEET: Liam (Manager)");
    expect(note).toContain("Aqua-Tots Lone Tree");
    expect(note).toContain("10:30"); // appointment in Mountain time
    expect(note).toContain("America/Denver");
    expect(note).toContain("Booked a demo with Liam.");
    expect(note).toContain("Lead response time: within 10 minutes");
    expect(note).toContain("Decision-maker reached: no");
    expect(note).toContain("Current AI tools: None");
    expect(note).toContain(
      "RECORDING: https://elevenlabs.io/app/agents/agents/A/history/C",
    );
  });

  test("omits sections with no data", () => {
    const note = buildHandoffNote({
      lead: {
        company: "Solo Co",
        ownerName: null,
        managerName: null,
        employeeName: null,
        businessPhone: null,
        businessEmail: null,
        timezone: null,
        city: null,
        state: null,
      },
      call: null,
      appointment: null,
      customFields: [],
    });
    expect(note).toContain("COMPANY: Solo Co");
    expect(note).not.toContain("BOOKED APPOINTMENT");
    expect(note).not.toContain("AI CALL SUMMARY");
    expect(note).not.toContain("KEY ANSWERS");
    expect(note).not.toContain("RECORDING");
  });

  test("a malformed timezone does not throw (falls back)", () => {
    expect(() =>
      buildHandoffNote({
        lead: {
          company: "Bad TZ Co",
          ownerName: null,
          managerName: null,
          employeeName: null,
          businessPhone: null,
          businessEmail: null,
          timezone: "America/Denverrr", // not a real IANA zone
          city: null,
          state: null,
        },
        call: null,
        appointment: {
          scheduledAt: "2026-07-01T16:30:00.000Z",
          eventLink: null,
        },
        customFields: [],
      }),
    ).not.toThrow();
  });
});

test.describe("Send to closer (UI)", () => {
  test.use({ storageState: "playwright/.auth/user.json" });

  const stamp = Date.now();
  let admin: SupabaseClient;
  let ownerId: string;
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
    // The button is admin-gated; ensure the E2E user is an admin.
    await admin.from("profiles").update({ role: "admin" }).eq("id", ownerId);
    // Exercise the not-connected path: ensure NO Close key for this owner.
    await admin
      .from("user_integrations")
      .update({ close_api_key: null })
      .eq("user_id", ownerId);
    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        company: `E2E Handoff ${stamp}`,
        business_phone: `+1555${String(stamp).slice(-7)}`,
        status: "goal_met",
      })
      .select("id")
      .single();
    leadId = lead!.id;
  });

  test.afterAll(async () => {
    await admin
      .from("system_events")
      .delete()
      .eq("ref_id", leadId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
  });

  test("admin sees the button; not-connected shows the connect error and logs nothing", async ({
    page,
  }) => {
    await page.goto(`/leads/${leadId}`);
    const button = page.getByRole("button", { name: /send to closer/i });
    await expect(button).toBeVisible();

    page.on("dialog", (d) => d.accept()); // accept the confirm()
    await button.click();
    await expect(page.getByText(/connect close in settings/i)).toBeVisible();

    const { count } = await admin
      .from("system_events")
      .select("id", { count: "exact", head: true })
      .eq("ref_id", leadId)
      .eq("kind", "lead_handoff");
    expect(count ?? 0).toBe(0);
  });
});
