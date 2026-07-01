import { test, expect } from "@playwright/test";

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
});
