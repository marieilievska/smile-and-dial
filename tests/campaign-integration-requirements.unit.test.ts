import { describe, expect, it } from "vitest";

import {
  campaignIntegrationRequirements,
  missingIntegrations,
  missingIntegrationsMessage,
} from "../src/lib/campaigns/integration-requirements";

describe("campaignIntegrationRequirements — what a campaign needs to go live", () => {
  const none = {
    agentToolsEnabled: {},
    calendlyEventId: null,
    fixedTimeBooking: false,
  };

  it("a plain calling campaign needs nothing", () => {
    expect(campaignIntegrationRequirements(none)).toEqual({
      needsCalendly: false,
      needsClose: false,
    });
    expect(
      campaignIntegrationRequirements({
        agentToolsEnabled: null,
        calendlyEventId: undefined,
        fixedTimeBooking: undefined,
      }),
    ).toEqual({ needsCalendly: false, needsClose: false });
  });

  it("tools that aren't booking or messaging don't require anything", () => {
    expect(
      campaignIntegrationRequirements({
        ...none,
        agentToolsEnabled: {
          schedule_callback: true,
          mark_dnc: true,
          demo_front_desk: true,
          transfer_to_number: true,
        },
      }),
    ).toEqual({ needsCalendly: false, needsClose: false });
  });

  it("a tool explicitly switched OFF doesn't count", () => {
    expect(
      campaignIntegrationRequirements({
        ...none,
        agentToolsEnabled: {
          get_available_times: false,
          book_appointment: false,
          send_email: false,
          send_text: false,
        },
      }),
    ).toEqual({ needsCalendly: false, needsClose: false });
  });

  it.each([
    ["get_available_times", { get_available_times: true }],
    ["book_appointment", { book_appointment: true }],
  ])("the %s tool needs Calendly", (_label, tools) => {
    expect(
      campaignIntegrationRequirements({ ...none, agentToolsEnabled: tools }),
    ).toEqual({ needsCalendly: true, needsClose: false });
  });

  it("a chosen Calendly event needs Calendly even with no booking tools", () => {
    expect(
      campaignIntegrationRequirements({ ...none, calendlyEventId: "evt-1" }),
    ).toEqual({ needsCalendly: true, needsClose: false });
  });

  it("a blank / whitespace event id is 'no event'", () => {
    expect(
      campaignIntegrationRequirements({ ...none, calendlyEventId: "   " }),
    ).toEqual({ needsCalendly: false, needsClose: false });
  });

  it("fixed-time booking needs Calendly", () => {
    expect(
      campaignIntegrationRequirements({ ...none, fixedTimeBooking: true }),
    ).toEqual({ needsCalendly: true, needsClose: false });
  });

  it.each([
    ["send_email", { send_email: true }],
    ["send_text", { send_text: true }],
  ])("the %s tool needs Close", (_label, tools) => {
    expect(
      campaignIntegrationRequirements({ ...none, agentToolsEnabled: tools }),
    ).toEqual({ needsCalendly: false, needsClose: true });
  });

  it("a booking + messaging agent needs both", () => {
    expect(
      campaignIntegrationRequirements({
        agentToolsEnabled: { book_appointment: true, send_text: true },
        calendlyEventId: "evt-1",
        fixedTimeBooking: true,
      }),
    ).toEqual({ needsCalendly: true, needsClose: true });
  });
});

describe("missingIntegrations — requirements minus what's connected", () => {
  it("only counts what's needed AND not connected", () => {
    expect(
      missingIntegrations(
        { needsCalendly: true, needsClose: true },
        { calendly: true, close: false },
      ),
    ).toEqual({ calendly: false, close: true });
    expect(
      missingIntegrations(
        { needsCalendly: false, needsClose: false },
        { calendly: false, close: false },
      ),
    ).toEqual({ calendly: false, close: false });
  });
});

describe("missingIntegrationsMessage — the launch blocker the user reads", () => {
  it("nothing missing → null (launch proceeds)", () => {
    expect(
      missingIntegrationsMessage({ calendly: false, close: false }),
    ).toBeNull();
  });

  it("Calendly missing", () => {
    expect(missingIntegrationsMessage({ calendly: true, close: false })).toBe(
      "Connect Calendly in Settings → Integrations before launching — this campaign's agent books appointments.",
    );
  });

  it("Close missing", () => {
    expect(missingIntegrationsMessage({ calendly: false, close: true })).toBe(
      "Connect Close in Settings → Integrations before launching — this campaign's agent sends emails or texts.",
    );
  });

  it("both missing", () => {
    expect(missingIntegrationsMessage({ calendly: true, close: true })).toBe(
      "Connect Calendly and Close in Settings → Integrations before launching — this campaign's agent books appointments and sends emails or texts.",
    );
  });

  it("an admin launching someone else's campaign is told the OWNER must connect", () => {
    expect(
      missingIntegrationsMessage(
        { calendly: true, close: false },
        { ownerIsActor: false },
      ),
    ).toBe(
      "The campaign owner needs to connect Calendly in Settings → Integrations before launching — this campaign's agent books appointments.",
    );
  });
});
