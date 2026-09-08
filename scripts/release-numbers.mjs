// DESTRUCTIVE, IRREVERSIBLE. Hands every un-released Twilio number back, strips
// it from the parent Trust Hub, and deletes its ElevenLabs phone-number object.
//
//   node scripts/release-numbers.mjs         dry run — prints the plan, changes nothing
//   node scripts/release-numbers.mjs --yes   performs it
//
// A released Twilio number is GONE. Re-buying means searching area code by area
// code again, and the local-presence spread has to be rebuilt from scratch.
// `scripts/wipe-data.mjs` deliberately KEEPS twilio_numbers and never touches
// ElevenLabs — this is the separate, sharper tool for handing the pool back.
//
// ── The trap this script exists to encode ───────────────────────────────────
// Twilio's Trust Hub hangs TWO different assignment collections off the same
// TrustProduct / CustomerProfile:
//
//   EntityAssignments          → entities: end-users, supporting documents, and
//                                the CustomerProfile linked to the product
//   ChannelEndpointAssignments → PHONE NUMBERS, keyed by `channel_endpoint_sid`
//
// Reading the wrong one does not fail. It returns 200 with a valid list of the
// wrong things, so a filter for our PN SIDs matches nothing and the script
// cheerfully reports "0 ours" while leaving every assignment behind. That bug
// shipped through two full wipes (2026-09-08), orphaning 184 then 176
// assignments that had to be removed by hand. BOTH halves matter: the resource
// name AND the `channel_endpoint_sid` key — `object_sid` is always undefined on
// a ChannelEndpointAssignment, so `ourSids.has(undefined)` is silently false.
//
// ⚠️ The EntityAssignments read further down is CORRECT and must stay — it is
// how the linked CustomerProfile SID is discovered. Do not blanket-replace it.
//
// ── Why this cannot touch another workspace ─────────────────────────────────
// Every ElevenLabs delete is driven by an id read from OUR OWN twilio_numbers
// table. This script never enumerates the ElevenLabs workspace and deletes what
// it finds, so even pointed at the wrong key it could only ever touch numbers
// this app recorded. A pre-flight additionally REFUSES to run if the workspace
// holds a single phone-number object we do not own — the shared Referrizer
// workspace carries ~90 numbers for other departments, which trips it at once.
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.argv.includes("--yes");

const env = Object.fromEntries(
  fs
    .readFileSync(`${ROOT}/.env.local`, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [
        l.slice(0, i).trim(),
        l
          .slice(i + 1)
          .trim()
          .replace(/^["']|["']$/g, ""),
      ];
    }),
);

const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const SBH = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};
const TW_AUTH =
  "Basic " +
  Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString(
    "base64",
  );
const PARENT_AUTH =
  "Basic " +
  Buffer.from(
    `${env.TWILIO_PARENT_ACCOUNT_SID}:${env.TWILIO_PARENT_AUTH_TOKEN}`,
  ).toString("base64");
const ELH = { "xi-api-key": env.ELEVENLABS_API_KEY };
const SHAKEN_POLICY_SID = "RN7a97559effdf62d00f4298208492a5ea";
const TRUSTHUB = "https://trusthub.twilio.com/v1";

// ---------------------------------------------------------------- pre-flight
const rows = await (
  await fetch(
    `${SB}/rest/v1/twilio_numbers?select=id,phone_number,twilio_sid,elevenlabs_phone_number_id&released_at=is.null&order=phone_number`,
    { headers: SBH },
  )
).json();
console.log(`Our numbers, not yet released: ${rows.length}`);

const elList = await (
  await fetch("https://api.elevenlabs.io/v1/convai/phone-numbers", {
    headers: ELH,
  })
).json();
const elArr = Array.isArray(elList) ? elList : (elList.phone_numbers ?? []);
const ourElIds = new Set(
  rows.map((r) => r.elevenlabs_phone_number_id).filter(Boolean),
);
const strangers = elArr
  .map((n) => n.phone_number_id ?? n.id)
  .filter((id) => id && !ourElIds.has(id));

console.log(`ElevenLabs workspace objects : ${elArr.length}`);
console.log(`  ...not ours                : ${strangers.length}`);
if (strangers.length > 0) {
  console.error(
    "\nABORT: the ElevenLabs workspace holds phone numbers this app does not own.",
  );
  console.error(
    "That means the API key is pointed at a shared workspace. Refusing to continue.",
  );
  console.error("Strangers:", strangers.slice(0, 20));
  process.exit(1);
}

// ------------------------------------------------------------- trust hub map
async function trustHub(method, path) {
  const r = await fetch(`${TRUSTHUB}${path}`, {
    method,
    headers: { Authorization: PARENT_AUTH },
  });
  const body = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}
const tpList = await trustHub("GET", "/TrustProducts?PageSize=200");
const tp = (tpList.body.results ?? []).find(
  (p) => p.policy_sid === SHAKEN_POLICY_SID,
);
if (!tp) {
  console.error(
    "ABORT: could not find the SHAKEN trust product on the parent account.",
  );
  process.exit(1);
}
// CORRECT use of EntityAssignments: the product's linked CustomerProfile is an
// ENTITY. Phone numbers are not, and are read separately below.
const ea = await trustHub(
  "GET",
  `/TrustProducts/${tp.sid}/EntityAssignments?PageSize=200`,
);
const profileSid = (ea.body.results ?? [])[0]?.object_sid;
console.log(`\nTrust Hub product : ${tp.sid} (${tp.friendly_name})`);
console.log(`Supporting profile: ${profileSid}`);

/** Every PHONE-NUMBER assignment under a Trust Hub container, paged. */
async function channelEndpointsFor(path) {
  const out = [];
  let url = `${path}/ChannelEndpointAssignments?PageSize=200`;
  while (url) {
    const r = await trustHub("GET", url);
    if (!r.ok) break;
    out.push(...(r.body.results ?? []));
    const next = r.body.meta?.next_page_url;
    url = next ? next.replace(TRUSTHUB, "") : null;
  }
  return out;
}
const ourSids = new Set(rows.map((r) => r.twilio_sid).filter(Boolean));
const onProduct = await channelEndpointsFor(`/TrustProducts/${tp.sid}`);
const onProfile = await channelEndpointsFor(`/CustomerProfiles/${profileSid}`);
// `channel_endpoint_sid` — NOT `object_sid`. See the header comment.
const prodHits = onProduct.filter((a) => ourSids.has(a.channel_endpoint_sid));
const profHits = onProfile.filter((a) => ourSids.has(a.channel_endpoint_sid));
console.log(
  `  assignments on product: ${onProduct.length} total, ${prodHits.length} ours`,
);
console.log(
  `  assignments on profile: ${onProfile.length} total, ${profHits.length} ours`,
);

if (!LIVE) {
  console.log(`\n--- DRY RUN ---`);
  console.log(`Would release ${rows.length} numbers at Twilio (PERMANENT).`);
  console.log(
    `Would delete ${ourElIds.size} ElevenLabs phone-number objects, by id, from our table.`,
  );
  console.log(
    `Would remove ${prodHits.length} product + ${profHits.length} profile Trust Hub assignments.`,
  );
  console.log(`Would mark ${rows.length} rows released.`);
  console.log(
    `\nFirst 5 numbers: ${rows
      .slice(0, 5)
      .map((r) => r.phone_number)
      .join(", ")}`,
  );
  console.log(`\nRe-run with --yes to perform it.`);
  process.exit(0);
}

// ------------------------------------------------------------------ do it
const failures = [];
let released = 0,
  elDeleted = 0;
for (const [i, n] of rows.entries()) {
  // 1. Twilio — the irreversible step.
  const tr = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers/${n.twilio_sid}.json`,
    { method: "DELETE", headers: { Authorization: TW_AUTH } },
  );
  if (!tr.ok && tr.status !== 404) {
    failures.push(`${n.phone_number}: twilio release ${tr.status}`);
    continue;
  }
  released++;

  // 2. ElevenLabs — BY THE ID FROM OUR TABLE, never by enumeration.
  let elOk = true;
  if (n.elevenlabs_phone_number_id) {
    const er = await fetch(
      `https://api.elevenlabs.io/v1/convai/phone-numbers/${n.elevenlabs_phone_number_id}`,
      {
        method: "DELETE",
        headers: ELH,
      },
    );
    elOk = er.ok || er.status === 404;
    if (elOk) elDeleted++;
    else failures.push(`${n.phone_number}: elevenlabs delete ${er.status}`);
  }

  // 3. Mark it released. Clear the EL id only once EL confirmed, so a miss
  //    stays visible instead of being papered over.
  const patch = {
    released_at: new Date().toISOString(),
    attached_campaign_id: null,
  };
  if (elOk) patch.elevenlabs_phone_number_id = null;
  await fetch(`${SB}/rest/v1/twilio_numbers?id=eq.${n.id}`, {
    method: "PATCH",
    headers: SBH,
    body: JSON.stringify(patch),
  });

  if ((i + 1) % 10 === 0) console.log(`  ...${i + 1}/${rows.length}`);
}
console.log(`\nReleased at Twilio      : ${released}/${rows.length}`);
console.log(`Deleted in ElevenLabs   : ${elDeleted}`);

// 4. Trust Hub — targeted, product first then profile (reverse of the add order).
let removed = 0;
for (const a of prodHits) {
  const r = await trustHub(
    "DELETE",
    `/TrustProducts/${tp.sid}/ChannelEndpointAssignments/${a.sid}`,
  );
  if (r.ok) removed++;
  else failures.push(`trusthub product ${a.channel_endpoint_sid}: ${r.status}`);
}
for (const a of profHits) {
  const r = await trustHub(
    "DELETE",
    `/CustomerProfiles/${profileSid}/ChannelEndpointAssignments/${a.sid}`,
  );
  if (r.ok) removed++;
  else failures.push(`trusthub profile ${a.channel_endpoint_sid}: ${r.status}`);
}
console.log(
  `Trust Hub assignments removed: ${removed}/${prodHits.length + profHits.length}`,
);

if (failures.length) {
  console.log(`\n${failures.length} FAILURE(S):`);
  for (const f of failures.slice(0, 30)) console.log(`  ${f}`);
} else {
  console.log(`\nNo failures.`);
}
