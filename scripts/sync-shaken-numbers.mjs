// Reconcile SHAKEN/STIR number assignments with the live subaccount pool.
//
// Makes the "Smile and Dial" secondary profile AND the SHAKEN/STIR trust product
// (both on the PARENT account) carry EXACTLY the set of numbers currently active
// on the subaccount. Buy a number -> it gets A-attestation. Release a number ->
// it drops off. Idempotent: run it after any buy/release, or on a schedule.
//
//   node scripts/sync-shaken-numbers.mjs           # apply changes
//   node scripts/sync-shaken-numbers.mjs --dry-run # show what WOULD change
//
// Needs TWILIO_PARENT_ACCOUNT_SID + TWILIO_PARENT_AUTH_TOKEN in .env.local (Trust
// Hub lives on the parent; the app's own subaccount creds can't write it, and
// the parent SID stays out of the committed source). Read-only against the app.
import fs from "node:fs";

const DRY = process.argv.includes("--dry-run");
const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const val = (k) =>
  (env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? "")
    .trim()
    .replace(/^"|"$/g, "");

const PARENT = val("TWILIO_PARENT_ACCOUNT_SID");
const PTOK = val("TWILIO_PARENT_AUTH_TOKEN");
const SUB = val("TWILIO_ACCOUNT_SID");
const STOK = val("TWILIO_AUTH_TOKEN");

// The approved Trust Hub resources these numbers must live on (see
// reference_twilio_trust_hub memory). SHAKEN/STIR is discovered by policy so a
// rebuilt product is picked up without editing this file.
const SECONDARY_SID = "BU3cbdfe1e1bb900f7680023ab439428ec"; // "Smile and Dial"
const SHAKEN_POLICY = "RN7a97559effdf62d00f4298208492a5ea";

if (!PARENT || !PTOK) {
  console.error(
    "Missing TWILIO_PARENT_ACCOUNT_SID or TWILIO_PARENT_AUTH_TOKEN in .env.local — cannot reach the parent Trust Hub.",
  );
  process.exit(1);
}
const pAuth = "Basic " + Buffer.from(`${PARENT}:${PTOK}`).toString("base64");
const sAuth = "Basic " + Buffer.from(`${SUB}:${STOK}`).toString("base64");

// One-line audit trail, so a silent scheduled run still leaves a record. Lives
// next to the repo (gitignored). Best-effort — logging must never break a sync.
const LOG = new URL("../.shaken-sync.log", import.meta.url);
function logLine(msg) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()}  ${msg}\n`);
  } catch {
    /* ignore */
  }
}

async function api(method, url, params, auth = pAuth) {
  const opts = { method, headers: { Authorization: auth } };
  if (params) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = new URLSearchParams(params);
  }
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}
const isDup = (r) =>
  !r.ok && (r.status === 409 || /already/i.test(r.body?.message ?? ""));

// Current channel-endpoint assignments on a container: PN sid -> assignment sid.
async function assignmentsOf(base) {
  const map = new Map();
  const r = await api("GET", `${base}/ChannelEndpointAssignments?PageSize=200`);
  for (const a of r.body.results ?? []) map.set(a.channel_endpoint_sid, a.sid);
  return map;
}

console.log(`SHAKEN/STIR number sync${DRY ? " (dry run)" : ""}`);

// Discover the SHAKEN/STIR trust product by policy.
const list = await api(
  "GET",
  "https://trusthub.twilio.com/v1/TrustProducts?PageSize=200",
);
const tp = (list.body.results ?? []).find(
  (p) => p.policy_sid === SHAKEN_POLICY,
);
if (!tp) {
  console.error(
    "No SHAKEN/STIR trust product on the parent. Build it first (see memory).",
  );
  process.exit(1);
}
const TP = tp.sid;

// The SHAKEN product's supporting customer profile — discovered from the
// product's OWN EntityAssignments rather than the hardcoded SECONDARY_SID, which
// drifted: the product was rebuilt as "Voice Agents" on a new profile
// (BUd21a37…), so every product-assign against the old BU3cbd… profile 400'd
// ("not assigned to all the required supporting … Customer profile"). Following
// the product means a future rebuild self-heals. Falls back to SECONDARY_SID.
const eaResp = await api(
  "GET",
  `https://trusthub.twilio.com/v1/TrustProducts/${TP}/EntityAssignments?PageSize=200`,
);
const PROFILE_SID = (eaResp.body.results ?? [])[0]?.object_sid ?? SECONDARY_SID;
const PROFILE_BASE = `https://trusthub.twilio.com/v1/CustomerProfiles/${PROFILE_SID}`;
const PRODUCT_BASE = `https://trusthub.twilio.com/v1/TrustProducts/${TP}`;

// The desired set: active (non-released) numbers on the subaccount.
const numsResp = await api(
  "GET",
  `https://api.twilio.com/2010-04-01/Accounts/${SUB}/IncomingPhoneNumbers.json?PageSize=200`,
  null,
  sAuth,
);
if (!numsResp.ok) {
  console.error(
    `Could not list subaccount numbers (${numsResp.status}). Aborting — no changes made.`,
  );
  logLine(
    `ERROR: subaccount number list failed (${numsResp.status}) — no changes`,
  );
  process.exit(1);
}
const active = (numsResp.body.incoming_phone_numbers ?? []).map((n) => ({
  pn: n.sid,
  e164: n.phone_number,
}));
const activePNs = new Set(active.map((n) => n.pn));
// SAFETY: never let a transient empty response trigger a mass removal.
if (activePNs.size === 0) {
  console.error(
    "Subaccount returned 0 active numbers — refusing to remove everything. Aborting.",
  );
  logLine("ERROR: 0 active numbers returned — refused mass removal");
  process.exit(1);
}
const e164Of = new Map(active.map((n) => [n.pn, n.e164]));

const onProfile = await assignmentsOf(PROFILE_BASE);
const onProduct = await assignmentsOf(PRODUCT_BASE);

const toAdd = active.filter(
  (n) => !onProduct.has(n.pn) || !onProfile.has(n.pn),
);
const staleProduct = [...onProduct.keys()].filter((pn) => !activePNs.has(pn));
const staleProfile = [...onProfile.keys()].filter((pn) => !activePNs.has(pn));

console.log(
  `\nActive numbers: ${active.size ?? active.length} | on product: ${onProduct.size} | on profile: ${onProfile.size}`,
);
console.log(
  `To add: ${toAdd.length} | to drop (product): ${staleProduct.length} | to drop (profile): ${staleProfile.length}`,
);

if (
  toAdd.length === 0 &&
  staleProduct.length === 0 &&
  staleProfile.length === 0
) {
  console.log("\n✓ Already in sync — nothing to do.");
  logLine(`in sync — ${active.length} numbers, no change`);
  process.exit(0);
}

if (DRY) {
  for (const n of toAdd) console.log(`  + would add    ${n.e164}`);
  for (const pn of staleProduct)
    console.log(`  - would drop   ${e164Of.get(pn) ?? pn} (from product)`);
  for (const pn of staleProfile)
    console.log(`  - would drop   ${e164Of.get(pn) ?? pn} (from profile)`);
  console.log("\n(dry run — nothing changed)");
  process.exit(0);
}

// ADD: profile FIRST, then product (Twilio requires the supporting profile to
// carry the number before the product will accept it).
for (const n of toAdd) {
  if (!onProfile.has(n.pn)) {
    const a = await api("POST", `${PROFILE_BASE}/ChannelEndpointAssignments`, {
      ChannelEndpointType: "phone-number",
      ChannelEndpointSid: n.pn,
    });
    console.log(
      `  ${a.ok || isDup(a) ? "+ profile" : "✗ profile " + a.status} ${n.e164}`,
    );
  }
  if (!onProduct.has(n.pn)) {
    const a = await api("POST", `${PRODUCT_BASE}/ChannelEndpointAssignments`, {
      ChannelEndpointType: "phone-number",
      ChannelEndpointSid: n.pn,
    });
    console.log(
      `  ${a.ok || isDup(a) ? "+ product" : "✗ product " + a.status} ${n.e164}`,
    );
  }
}

// REMOVE: product FIRST, then profile (reverse of the dependency).
for (const pn of staleProduct) {
  const a = await api(
    "DELETE",
    `${PRODUCT_BASE}/ChannelEndpointAssignments/${onProduct.get(pn)}`,
  );
  console.log(
    `  ${a.ok ? "- product" : "✗ product " + a.status} ${e164Of.get(pn) ?? pn}`,
  );
}
for (const pn of staleProfile) {
  const a = await api(
    "DELETE",
    `${PROFILE_BASE}/ChannelEndpointAssignments/${onProfile.get(pn)}`,
  );
  console.log(
    `  ${a.ok ? "- profile" : "✗ profile " + a.status} ${e164Of.get(pn) ?? pn}`,
  );
}

logLine(
  `synced — added ${toAdd.length}, dropped ${staleProduct.length + staleProfile.length}`,
);
console.log("\n✓ Sync complete.");
