import { test, expect } from "@playwright/test";

import { mintVoiceToken } from "../src/lib/twilio/voice-token";

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

test("mintVoiceToken builds a Twilio FPA voice grant token", () => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_API_KEY_SID = "SKtest";
  process.env.TWILIO_API_KEY_SECRET = "secret123";
  process.env.TWILIO_TWIML_APP_SID = "APtest";

  const token = mintVoiceToken({ identity: "user-1", nowSeconds: 1_000 });
  const [headerB64, payloadB64] = token.split(".");
  const header = decodeJwtPart(headerB64);
  const payload = decodeJwtPart(payloadB64);

  expect(header.cty).toBe("twilio-fpa;v=1");
  expect(payload.iss).toBe("SKtest");
  expect(payload.sub).toBe("ACtest");
  expect(payload.exp).toBe(1_000 + 3600);
  const grants = payload.grants as Record<string, unknown>;
  expect(grants.identity).toBe("user-1");
  const voice = grants.voice as { outgoing: { application_sid: string } };
  expect(voice.outgoing.application_sid).toBe("APtest");
});
