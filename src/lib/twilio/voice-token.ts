import crypto from "node:crypto";

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint a short-lived Twilio Voice access token (a "first-party access" JWT)
 * the browser SDK uses to connect. Hand-rolled with node crypto so we don't
 * pull in the Twilio server SDK — mirrors the existing hand-rolled Twilio HMAC
 * signature code in status-webhook.ts.
 *
 * `nowSeconds` is injectable for deterministic tests; defaults to wall clock.
 */
export function mintVoiceToken(opts: {
  identity: string;
  nowSeconds?: number;
}): string {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const apiKeySid = process.env.TWILIO_API_KEY_SID ?? "";
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET ?? "";
  const appSid = process.env.TWILIO_TWIML_APP_SID ?? "";
  if (!accountSid || !apiKeySid || !apiKeySecret || !appSid) {
    throw new Error(
      "Voice token requires TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID.",
    );
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${apiKeySid}-${now}`,
    iss: apiKeySid,
    sub: accountSid,
    nbf: now,
    exp: now + 3600,
    grants: {
      identity: opts.identity,
      voice: {
        incoming: { allow: false },
        outgoing: { application_sid: appSid },
      },
    },
  };
  const enc = (o: object) => base64url(JSON.stringify(o));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const signature = base64url(
    crypto.createHmac("sha256", apiKeySecret).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}
