import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Relative import (not the `@/` alias): keeps the pure helper resolvable under
// Playwright's loader, matching how the other specs import. buildHandoffNote has
// no server-only/Next imports, so pulling it into a test is safe.
import {
  buildHandoffNote,
  buildHandoffTaskText,
  pickKeyAnswers,
} from "../src/lib/close/handoff";

test.describe("buildHandoffNote", () => {
  test("renders a per-call history, appointment (lead tz), single key answer", () => {
    const note = buildHandoffNote({
      lead: {
        company: "Aqua-Tots Myers Park",
        ownerName: null,
        managerName: "Jessica",
        employeeName: null,
        businessPhone: "+17045858155",
        businessEmail: "myersparkgm@aqua-tots.com",
        timezone: "America/New_York",
        city: "Charlotte",
        state: "NC",
      },
      calls: [
        {
          startedAt: "2026-06-30T13:45:57.940Z", // 9:45 AM ET
          outcome: "callback",
          summary: "First call — reached Clover, got response time.",
          recordingUrl: "https://elevenlabs.io/app/agents/agents/A/history/C1",
        },
        {
          startedAt: "2026-06-30T16:30:00.000Z", // 12:30 PM ET
          outcome: "goal_met",
          summary: "Booked a demo for 3 PM.",
          recordingUrl: "https://elevenlabs.io/app/agents/agents/A/history/C2",
        },
      ],
      leadResponseTime: "within a couple hours",
      decisionMakerReached: "unknown",
      appointment: { scheduledAt: "2026-06-30T19:00:00.000Z", eventLink: null }, // 3 PM ET
      contextSummary:
        "Reached Jessica, the GM. She's interested in the AI intake tool and asked about pricing.",
      customFields: [{ label: "Current ai tools", value: "None" }],
    });

    expect(note).toContain("CALL HISTORY (2 calls)");
    expect(note).toContain("First call — reached Clover, got response time.");
    expect(note).toContain("Booked a demo for 3 PM.");
    expect(note).toContain("9:45"); // first call, ET
    expect(note).toContain("12:30"); // second call, ET
    expect(note).toContain("goal met"); // outcome underscores → spaces
    expect(note).toContain("history/C1");
    expect(note).toContain("history/C2");
    expect(note).toContain("3:00 PM"); // appointment, ET
    // Lead response time appears exactly once (the caller dedups custom fields).
    expect(note.match(/Lead response time/g)?.length).toBe(1);
    expect(note).toContain("Current ai tools: None");
    // The rolling summary renders under its own heading, above the raw history.
    expect(note).toContain("SUMMARY:");
    expect(note).toContain("interested in the AI intake tool");
    expect(note.indexOf("SUMMARY:")).toBeLessThan(note.indexOf("CALL HISTORY"));
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
      calls: [],
      leadResponseTime: null,
      decisionMakerReached: null,
      appointment: null,
      contextSummary: null,
      customFields: [],
    });
    expect(note).toContain("COMPANY: Solo Co");
    expect(note).not.toContain("CALL HISTORY");
    expect(note).not.toContain("BOOKED APPOINTMENT");
    expect(note).not.toContain("KEY ANSWERS");
    expect(note).not.toContain("SUMMARY:");
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
          timezone: "America/Denverrr",
          city: null,
          state: null,
        },
        calls: [],
        leadResponseTime: null,
        decisionMakerReached: null,
        appointment: {
          scheduledAt: "2026-07-01T16:30:00.000Z",
          eventLink: null,
        },
        contextSummary: null,
        customFields: [],
      }),
    ).not.toThrow();
  });
});

test.describe("pickKeyAnswers", () => {
  test("a 'reached = yes' on any call wins over a newer noisy 'no'", () => {
    // Body Magic Co.: the newest call was a short follow-up whose extraction
    // wrongly said the decision-maker was NOT reached; the real appointment call
    // (earlier) reached the owner. Calls are passed newest-first.
    const answers = pickKeyAnswers([
      {
        extractedData: {
          decision_maker_reached: "no",
          lead_response_time: null,
        },
      },
      {
        extractedData: {
          decision_maker_reached: "yes",
          lead_response_time: "An hour or two at most, usually quicker.",
        },
      },
    ]);
    expect(answers.decisionMakerReached).toBe("yes");
    expect(answers.leadResponseTime).toBe(
      "An hour or two at most, usually quicker.",
    );
  });

  test("free-text answers use the most recent non-empty call", () => {
    const answers = pickKeyAnswers([
      { extractedData: { lead_response_time: "  " } }, // newest, blank
      { extractedData: { lead_response_time: "same day" } },
      { extractedData: { lead_response_time: "next week" } },
    ]);
    expect(answers.leadResponseTime).toBe("same day");
  });

  test("returns nulls when no call carries the answers", () => {
    const answers = pickKeyAnswers([
      { extractedData: null },
      { extractedData: {} },
    ]);
    expect(answers.decisionMakerReached).toBeNull();
    expect(answers.leadResponseTime).toBeNull();
  });
});

test.describe("buildHandoffTaskText", () => {
  test("includes company, appt time in lead tz, and contact", () => {
    const text = buildHandoffTaskText({
      company: "Aqua-Tots Lone Tree",
      ownerName: null,
      managerName: "Liam",
      employeeName: null,
      businessPhone: "+13037311363",
      businessEmail: "info@aqua-tots.com",
      timezone: "America/Denver",
      appointmentAt: "2026-07-01T16:30:00.000Z", // 10:30 AM Mountain
    });
    expect(text).toContain("Aqua-Tots Lone Tree");
    expect(text).toContain("10:30");
    expect(text).toContain("America/Denver");
    expect(text).toContain("Liam");
    expect(text).toContain("info@aqua-tots.com");
    expect(text).toContain("handoff note");
  });

  test("degrades gracefully with no appointment", () => {
    const text = buildHandoffTaskText({
      company: "Solo Co",
      ownerName: null,
      managerName: null,
      employeeName: null,
      businessPhone: null,
      businessEmail: null,
      timezone: null,
      appointmentAt: null,
    });
    expect(text).toContain("Solo Co");
    expect(text).not.toContain("—"); // the em-dash only appears with an appt time
    expect(text).toContain("handoff note");
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

    const dialogPromise = page.waitForEvent("dialog");
    await button.click();
    await (await dialogPromise).accept();
    await expect(page.getByText(/connect close in settings/i)).toBeVisible();

    const { count } = await admin
      .from("system_events")
      .select("id", { count: "exact", head: true })
      .eq("ref_id", leadId)
      .eq("kind", "lead_handoff");
    expect(count ?? 0).toBe(0);
  });
});
