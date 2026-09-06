import { describe, expect, it } from "vitest";

import {
  emailNotSentMessage,
  emailToolReadiness,
} from "../src/lib/close/email-send-plan";
import { textNotSentMessage } from "../src/lib/close/text-send-plan";

/** The in-call send_email / send_text tools must never let the agent tell a
 *  lead "I've sent that" (or the softer "I've noted to send that", which the
 *  lead hears as a yes) when nothing is going out. These pin the pure
 *  decision + the wording the model is handed with success:false. */

describe("emailToolReadiness — does send_email have anything to send?", () => {
  it("no template on the campaign: not ready, in any mode", () => {
    expect(
      emailToolReadiness({ live: true, hasTemplate: false, hasCloseKey: true }),
    ).toEqual({ ready: false, reason: "no_template_on_campaign" });
    expect(
      emailToolReadiness({
        live: false,
        hasTemplate: false,
        hasCloseKey: false,
      }),
    ).toEqual({ ready: false, reason: "no_template_on_campaign" });
  });

  it("live with a template but no Close connection: not ready", () => {
    expect(
      emailToolReadiness({ live: true, hasTemplate: true, hasCloseKey: false }),
    ).toEqual({ ready: false, reason: "owner_close_not_connected" });
  });

  it("live + template + Close: ready", () => {
    expect(
      emailToolReadiness({ live: true, hasTemplate: true, hasCloseKey: true }),
    ).toEqual({ ready: true });
  });

  it("non-live with a template is ready without Close (mock row)", () => {
    expect(
      emailToolReadiness({
        live: false,
        hasTemplate: true,
        hasCloseKey: false,
      }),
    ).toEqual({ ready: true });
  });
});

describe("what the agent is told when nothing was sent", () => {
  const emailReasons = [
    "no_template_on_campaign",
    "owner_close_not_connected",
    "no_connected_sending_email",
    "close_send_failed",
    "close_exception",
  ];
  const textReasons = [
    "no_template_on_campaign",
    "owner_close_not_connected",
    "no_sms_from_number",
    "close_send_failed",
    "close_exception",
  ];

  it("email: says it did NOT go out, never 'noted to send' or 'sent'", () => {
    for (const reason of emailReasons) {
      const msg = emailNotSentMessage(reason);
      expect(msg).toMatch(/can't send|couldn't send/i);
      expect(msg).not.toMatch(/noted to send|I've sent|Done —/i);
    }
  });

  it("email: names the gap for the configuration reasons", () => {
    expect(emailNotSentMessage("no_template_on_campaign")).toMatch(
      /can't send emails from this campaign yet/i,
    );
    expect(emailNotSentMessage("owner_close_not_connected")).toMatch(
      /isn't connected/i,
    );
  });

  it("text: says it did NOT go out, never 'noted to text'", () => {
    for (const reason of textReasons) {
      const msg = textNotSentMessage(reason);
      expect(msg).toMatch(/can't send|couldn't send/i);
      expect(msg).not.toMatch(/noted to text|I've texted|Done —/i);
    }
  });

  it("text: the missing-number case says exactly that", () => {
    expect(textNotSentMessage("no_sms_from_number")).toBe(
      "I couldn't send the text: no texting number is set up in Close. I've made a note for the team to follow up.",
    );
  });
});
