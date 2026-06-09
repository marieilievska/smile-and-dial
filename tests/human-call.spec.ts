import { test, expect } from "@playwright/test";

import { mintVoiceToken } from "../src/lib/twilio/voice-token";
import { buildDialTwiml } from "../src/lib/twilio/human-call";
import { transcribeAudioUrl } from "../src/lib/openai/transcribe";

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

test("transcribeAudioUrl returns null in mock mode", async () => {
  delete process.env.OPENAI_LIVE;
  const result = await transcribeAudioUrl("https://example.com/rec.mp3");
  expect(result).toBeNull();
});

test("buildDialTwiml dials the lead from the caller id with recording on", () => {
  const xml = buildDialTwiml({
    leadPhone: "+16505551234",
    callerId: "+18885550000",
    appBaseUrl: "https://app.example.com",
  });
  expect(xml).toContain('callerId="+18885550000"');
  expect(xml).toContain("record-from-answer-dual");
  expect(xml).toContain("https://app.example.com/api/twilio/recording");
  expect(xml).toContain("<Number");
  expect(xml).toContain("+16505551234");
  expect(xml.startsWith("<?xml")).toBe(true);
});
