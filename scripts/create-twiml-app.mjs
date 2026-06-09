// Run once after deploy:  node scripts/create-twiml-app.mjs https://<deployed-app>
//
// Creates the Twilio "TwiML App" that browser calling needs: a small config
// object whose Voice URL points at our /api/twilio/voice-browser-dial handler.
// Prints `TWILIO_TWIML_APP_SID=AP...` — add that to .env.local and production.
import fs from "node:fs";

const base = process.argv[2];
if (!base) {
  console.error("Usage: node scripts/create-twiml-app.mjs https://<app-url>");
  process.exit(1);
}
const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const sid = env.TWILIO_ACCOUNT_SID;
const token = env.TWILIO_AUTH_TOKEN;
if (!sid || !token) {
  console.error(
    "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing from .env.local",
  );
  process.exit(1);
}
const auth = Buffer.from(`${sid}:${token}`).toString("base64");

const body = new URLSearchParams({
  FriendlyName: "Smile & Dial — Browser Calling",
  VoiceUrl: `${base}/api/twilio/voice-browser-dial`,
  VoiceMethod: "POST",
});
const res = await fetch(
  `https://api.twilio.com/2010-04-01/Accounts/${sid}/Applications.json`,
  {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  },
);
const json = await res.json();
if (!res.ok) {
  console.error("Failed:", json);
  process.exit(1);
}
console.log("TWILIO_TWIML_APP_SID=" + json.sid);
