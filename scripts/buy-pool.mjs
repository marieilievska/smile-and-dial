// Buys a local-presence NUMBER POOL from a plan file, straight into a campaign,
// the way the in-app "Buy into pool" dialog does — for the whole plan at once.
//
//   node scripts/buy-pool.mjs <plan.json>            dry run — prints the plan, buys nothing
//   node scripts/buy-pool.mjs <plan.json> --yes      buys (SPENDS MONEY: monthly rental per number)
//   node scripts/buy-pool.mjs --verify               only the post-buy verification
//
// Plan shape (one row per state/province):
//   [{ "region": "FL", "country": "US", "target": 5,
//      "buys": [{ "areaCode": "561", "count": 1 }, ...],   // preferred codes, in order
//      "fallback": ["786", "727", ...] }]                    // same-region codes to try if a buy code runs dry
//
// ── Why raw REST and not the app's helpers ──────────────────────────────────
// `purchaseTwilioNumber` and `importTwilioNumberToElevenLabs` each sit behind an
// env gate (TWILIO_LIVE / ELEVENLABS_LIVE) whose MOCK returns a SUCCESS shape.
// On 2026-09-08 a buy run reported "48 imported to ElevenLabs" while the
// workspace held 0 and every row carried a `phnum_mock_…` id — the numbers were
// real and signed and could not place a call. This script calls the three APIs
// directly, so there is no mock to mistake for success, and it VERIFIES the pool
// against Twilio + ElevenLabs + Trust Hub at the end instead of trusting its own
// tally.
//
// Per number, in the app's order (src/lib/twilio/pool-actions.ts addNumbersToPool):
//   1. Twilio: buy it, then point VoiceUrl/StatusCallback at ElevenLabs' native
//      inbound (EL answers with the number's assigned agent — never this app).
//   2. DB: twilio_numbers row attached to the campaign, area code stamped,
//      warm-up starting now, pool_status active.
//   3. ElevenLabs: import (for outbound) and assign the campaign's agent (inbound).
//   4. Trust Hub (US only — SHAKEN/STIR is a US framework): supporting customer
//      profile FIRST, then the trust product. Canadian numbers are skipped, not
//      failed; the 30-minute shaken-reconcile cron heals any miss.
//
// Never leaves the region: a fallback code must map to the same state/province
// in nanp_area_codes, because the dialer's state tier matches on REGION — an
// out-of-state caller ID would not even match its own leads.
//
// Idempotent: numbers already in the pool count toward each region's target, so
// a crashed run can simply be re-run.
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const LIVE = args.includes("--yes");
const VERIFY_ONLY = args.includes("--verify");
const planPath = args.find((a) => !a.startsWith("--"));
const campaignArg = args.find((a) => a.startsWith("--campaign="))?.slice(11);
/** Hard ceiling per run so a malformed plan can't drain the account. */
const MAX_PURCHASES = 100;

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
for (const k of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "ELEVENLABS_API_KEY",
  "TWILIO_PARENT_ACCOUNT_SID",
  "TWILIO_PARENT_AUTH_TOKEN",
]) {
  if (!env[k]) {
    console.error(`ABORT: ${k} missing from .env.local`);
    process.exit(1);
  }
}

const SB = env.NEXT_PUBLIC_SUPABASE_URL;
const SBH = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};
const TW_ACCOUNT = env.TWILIO_ACCOUNT_SID;
const TW_API = `https://api.twilio.com/2010-04-01/Accounts/${TW_ACCOUNT}`;
const TW_AUTH =
  "Basic " +
  Buffer.from(
    `${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`,
  ).toString("base64");
const PARENT_AUTH =
  "Basic " +
  Buffer.from(
    `${env.TWILIO_PARENT_ACCOUNT_SID}:${env.TWILIO_PARENT_AUTH_TOKEN}`,
  ).toString("base64");
const EL = "https://api.elevenlabs.io";
const ELH = {
  "xi-api-key": env.ELEVENLABS_API_KEY,
  "Content-Type": "application/json",
};
const TRUSTHUB = "https://trusthub.twilio.com/v1";
const SHAKEN_POLICY_SID = "RN7a97559effdf62d00f4298208492a5ea";
// Same constants as src/lib/twilio/numbers.ts expectedNumberWebhooks().
const VOICE_URL = "https://api.elevenlabs.io/twilio/inbound_call";
const STATUS_CALLBACK = "https://api.elevenlabs.io/twilio/status-callback";
// src/lib/costs/rates.ts twilioNumberMonthlyUsd(): negotiated US rate, CA list price.
const MONTHLY = {
  US: Number(env.TWILIO_NUMBER_MONTHLY_COST ?? 0.04),
  CA: Number(env.TWILIO_NUMBER_MONTHLY_COST_CA ?? 1.15),
};

async function sb(path, init) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { ...SBH, ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: r.ok, status: r.status, body };
}
async function twilio(method, path, params) {
  const r = await fetch(`${TW_API}/${path}`, {
    method,
    headers: {
      Authorization: TW_AUTH,
      ...(params
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}
async function trustHub(method, path, params) {
  const r = await fetch(path.startsWith("http") ? path : `${TRUSTHUB}${path}`, {
    method,
    headers: {
      Authorization: PARENT_AUTH,
      ...(params
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const body = r.status === 204 ? {} : await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}
// A POST that already exists (409 / "already") is a success — assignment is idempotent.
const assignedOk = (r) =>
  r.ok || r.status === 409 || /already/i.test(r.body?.message ?? "");
const areaCodeOf = (e164) => /^\+1(\d{3})\d{7}$/.exec(e164 ?? "")?.[1] ?? null;

// ------------------------------------------------------------------ shared reads
async function readPool() {
  const r = await sb(
    "twilio_numbers?select=id,phone_number,area_code,country,twilio_sid,elevenlabs_phone_number_id,attached_campaign_id,pool_status,friendly_name&released_at=is.null&order=phone_number",
  );
  if (!r.ok) throw new Error(`pool read failed ${r.status}`);
  return r.body;
}
async function twilioOwned() {
  const out = [];
  let path = "IncomingPhoneNumbers.json?PageSize=1000";
  for (let i = 0; i < 10 && path; i++) {
    const r = await twilio("GET", path);
    if (!r.ok) throw new Error(`Twilio list failed ${r.status}`);
    out.push(...(r.body.incoming_phone_numbers ?? []));
    path = r.body.next_page_uri
      ? r.body.next_page_uri.replace(`/2010-04-01/Accounts/${TW_ACCOUNT}/`, "")
      : null;
  }
  return out;
}
async function elNumbers() {
  const r = await fetch(`${EL}/v1/convai/phone-numbers`, { headers: ELH });
  if (!r.ok) throw new Error(`ElevenLabs list failed ${r.status}`);
  const b = await r.json();
  return Array.isArray(b) ? b : (b.phone_numbers ?? []);
}
async function resolveShaken() {
  const list = await trustHub("GET", "/TrustProducts?PageSize=200");
  const tp = (list.body.results ?? []).find(
    (p) => p.policy_sid === SHAKEN_POLICY_SID,
  );
  if (!tp) return null;
  // EntityAssignments is CORRECT here: the linked CustomerProfile is an ENTITY.
  // Phone numbers live on ChannelEndpointAssignments (read separately).
  const ea = await trustHub(
    "GET",
    `/TrustProducts/${tp.sid}/EntityAssignments?PageSize=200`,
  );
  const profileSid = (ea.body.results ?? [])
    .map((x) => x.object_sid)
    .find((s) => s?.startsWith("BU"));
  if (!profileSid) return null;
  return { trustProductSid: tp.sid, profileSid, name: tp.friendly_name };
}
async function channelEndpoints(containerPath) {
  const out = [];
  let url = `${containerPath}/ChannelEndpointAssignments?PageSize=200`;
  for (let i = 0; i < 50 && url; i++) {
    const r = await trustHub("GET", url);
    if (!r.ok) return null;
    out.push(...(r.body.results ?? []));
    url = r.body.meta?.next_page_url ?? null;
  }
  return out;
}

// ------------------------------------------------------------------ verification
async function verify(shaken) {
  const pool = await readPool();
  const owned = await twilioOwned();
  const el = await elNumbers();
  const ownedSids = new Set(owned.map((n) => n.sid));
  const elIds = new Set(el.map((n) => n.phone_number_id ?? n.id));
  const us = pool.filter((n) => n.country === "US");
  const ca = pool.filter((n) => n.country === "CA");
  const problems = [];
  for (const n of pool) {
    if (!n.twilio_sid || !ownedSids.has(n.twilio_sid))
      problems.push(`${n.phone_number}: not on the Twilio account`);
    if (!n.elevenlabs_phone_number_id)
      problems.push(`${n.phone_number}: no ElevenLabs id`);
    else if (n.elevenlabs_phone_number_id.startsWith("phnum_mock"))
      problems.push(`${n.phone_number}: MOCK ElevenLabs id`);
    else if (!elIds.has(n.elevenlabs_phone_number_id))
      problems.push(`${n.phone_number}: ElevenLabs id not in workspace`);
    if (!n.attached_campaign_id)
      problems.push(`${n.phone_number}: not attached to a campaign`);
    if (n.pool_status !== "active")
      problems.push(`${n.phone_number}: pool_status ${n.pool_status}`);
    if (!n.area_code) problems.push(`${n.phone_number}: no area_code`);
  }
  const strangersTw = owned.filter(
    (n) => !pool.some((p) => p.twilio_sid === n.sid),
  ).length;
  const strangersEl = el.filter(
    (n) =>
      !pool.some(
        (p) => p.elevenlabs_phone_number_id === (n.phone_number_id ?? n.id),
      ),
  ).length;
  const withAgent = el.filter(
    (n) => n.assigned_agent?.agent_id || n.agent_id,
  ).length;
  const badWebhooks = owned.filter(
    (n) => n.voice_url !== VOICE_URL || n.status_callback !== STATUS_CALLBACK,
  ).length;
  let onProduct = null;
  let onProfile = null;
  if (shaken) {
    const prod = await channelEndpoints(
      `/TrustProducts/${shaken.trustProductSid}`,
    );
    const prof = await channelEndpoints(
      `/CustomerProfiles/${shaken.profileSid}`,
    );
    const usSids = new Set(us.map((n) => n.twilio_sid));
    onProduct = prod
      ? prod.filter((a) => usSids.has(a.channel_endpoint_sid)).length
      : "read failed";
    onProfile = prof
      ? prof.filter((a) => usSids.has(a.channel_endpoint_sid)).length
      : "read failed";
  }
  console.log(
    `\n=== VERIFY (against the live APIs, not this script's tally) ===`,
  );
  console.log(
    `DB pool rows            : ${pool.length}  (US ${us.length}, CA ${ca.length})`,
  );
  console.log(
    `Twilio account numbers  : ${owned.length}  (${strangersTw} not in our table; ${badWebhooks} with webhooks not at ElevenLabs)`,
  );
  console.log(
    `ElevenLabs numbers      : ${el.length}  (${strangersEl} not in our table; ${withAgent} with an inbound agent)`,
  );
  console.log(
    `Trust Hub, US numbers   : product ${onProduct} / profile ${onProfile}  (expect ${us.length} each; CA is never signed)`,
  );
  console.log(`Row problems            : ${problems.length}`);
  for (const p of problems.slice(0, 40)) console.log(`  - ${p}`);
  return { pool, problems };
}

// ------------------------------------------------------------------ pre-flight
const shaken = await resolveShaken();
if (VERIFY_ONLY) {
  await verify(shaken);
  process.exit(0);
}
if (!planPath) {
  console.error(
    "usage: node scripts/buy-pool.mjs <plan.json> [--yes] [--campaign=<id>]",
  );
  process.exit(1);
}
const plan = JSON.parse(fs.readFileSync(planPath, "utf8")).filter(
  (r) => (r.target ?? 0) > 0,
);

const camps = (
  await sb(
    "campaigns?select=id,name,owner_id,status,agent:agents(elevenlabs_agent_id)&ended_at=is.null",
  )
).body;
const campaign = campaignArg
  ? camps.find((c) => c.id === campaignArg)
  : camps.length === 1
    ? camps[0]
    : null;
if (!campaign) {
  console.error(
    `ABORT: ${camps.length} campaigns found — pass --campaign=<id>:`,
    camps.map((c) => `${c.id} ${c.name}`),
  );
  process.exit(1);
}
const agentElId = campaign.agent?.elevenlabs_agent_id ?? null;

const nanp = (
  await sb("nanp_area_codes?select=area_code,state,country&limit=2000")
).body;
const regionOf = new Map(nanp.map((r) => [r.area_code, r.state]));

const pool = await readPool();
const owned = await twilioOwned();
const el = await elNumbers();
const ourElIds = new Set(
  pool.map((r) => r.elevenlabs_phone_number_id).filter(Boolean),
);
const strangers = el
  .map((n) => n.phone_number_id ?? n.id)
  .filter((id) => id && !ourElIds.has(id));

console.log(`Campaign          : ${campaign.name} (${campaign.id})`);
console.log(
  `Inbound agent     : ${agentElId ?? "NONE — inbound will not be assigned"}`,
);
console.log(
  `ElevenLabs key    : ${env.ELEVENLABS_API_KEY.slice(0, 7)}… (${el.length} numbers in workspace, ${strangers.length} not ours)`,
);
console.log(
  `Twilio subaccount : ${TW_ACCOUNT.slice(0, 8)}… (${owned.length} numbers owned)`,
);
console.log(`DB pool           : ${pool.length} rows not released`);
console.log(
  `Trust Hub         : ${shaken ? `${shaken.name} — product ${shaken.trustProductSid}, profile ${shaken.profileSid}` : "NOT RESOLVED — US numbers would dial unsigned"}`,
);
if (strangers.length > 0) {
  console.error(
    "\nABORT: the ElevenLabs workspace holds phone numbers this app does not own — wrong (shared) workspace key?",
  );
  console.error("Strangers:", strangers.slice(0, 20));
  process.exit(1);
}
if (!shaken) {
  console.error(
    "\nABORT: SHAKEN trust product/profile not resolved on the parent account.",
  );
  process.exit(1);
}
if (!agentElId) {
  console.error(
    "\nABORT: the campaign has no ElevenLabs agent; inbound could not be assigned.",
  );
  process.exit(1);
}

// Region → numbers already in the pool for THIS campaign.
const haveByRegion = new Map();
for (const n of pool) {
  if (n.attached_campaign_id !== campaign.id) continue;
  const reg = regionOf.get(n.area_code ?? areaCodeOf(n.phone_number));
  if (reg) haveByRegion.set(reg, (haveByRegion.get(reg) ?? 0) + 1);
}
let totalNeed = 0;
let usNeed = 0;
console.log(
  `\nregion | country | target | have | need | codes (preferred → fallback)`,
);
for (const r of plan) {
  // Every code must sit in the region it claims — the dial-time definition of local.
  for (const c of [...r.buys.map((b) => b.areaCode), ...(r.fallback ?? [])]) {
    if (regionOf.get(c) !== r.region) {
      console.error(
        `ABORT: plan puts ${c} under ${r.region}, but nanp_area_codes says ${regionOf.get(c) ?? "unknown"}`,
      );
      process.exit(1);
    }
  }
  const have = haveByRegion.get(r.region) ?? 0;
  const need = Math.max(0, r.target - have);
  totalNeed += need;
  if (r.country === "US") usNeed += need;
  const fb = r.fallback ?? [];
  console.log(
    `${r.region} | ${r.country} | ${r.target} | ${have} | ${need} | ${r.buys.map((b) => `${b.count}×${b.areaCode}`).join(" ")} → ${fb.slice(0, 6).join(" ")}${fb.length > 6 ? " …" : ""}`,
  );
}
const caNeed = totalNeed - usNeed;
console.log(
  `\nTo buy: ${totalNeed} numbers (US ${usNeed} × $${MONTHLY.US}/mo + CA ${caNeed} × $${MONTHLY.CA}/mo ≈ $${(usNeed * MONTHLY.US + caNeed * MONTHLY.CA).toFixed(2)}/mo)`,
);
if (totalNeed > MAX_PURCHASES) {
  console.error(
    `ABORT: ${totalNeed} exceeds the per-run ceiling of ${MAX_PURCHASES}.`,
  );
  process.exit(1);
}
if (!LIVE) {
  console.log(`\n--- DRY RUN --- nothing bought. Re-run with --yes to buy.`);
  process.exit(0);
}

// ------------------------------------------------------------------ buy
const log = [];
const failures = [];
let purchases = 0;

async function afterPurchase(region, country, bought) {
  const rec = {
    region,
    country,
    phone: bought.phone_number,
    sid: bought.sid,
    webhooks: false,
    row: null,
    elId: null,
    agent: false,
    shaken: country === "CA" ? "skipped (CA)" : null,
  };
  log.push(rec);
  // 1b. Webhooks → ElevenLabs native inbound.
  const wh = await twilio("POST", `IncomingPhoneNumbers/${bought.sid}.json`, {
    VoiceUrl: VOICE_URL,
    VoiceMethod: "POST",
    StatusCallback: STATUS_CALLBACK,
    StatusCallbackMethod: "POST",
  });
  rec.webhooks = wh.ok;
  if (!wh.ok)
    failures.push(`${bought.phone_number}: webhook update ${wh.status}`);
  // 2. DB row.
  const ins = await sb("twilio_numbers", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      owner_id: campaign.owner_id,
      phone_number: bought.phone_number,
      friendly_name: bought.friendly_name,
      country,
      monthly_cost: MONTHLY[country],
      twilio_sid: bought.sid,
      voice_webhook_url: wh.ok ? VOICE_URL : null,
      status_webhook_url: wh.ok ? STATUS_CALLBACK : null,
      attached_campaign_id: campaign.id,
      area_code: areaCodeOf(bought.phone_number),
      pool_status: "active",
      warmup_started_at: new Date().toISOString(),
    }),
  });
  const row = Array.isArray(ins.body) ? ins.body[0] : null;
  if (!ins.ok || !row) {
    failures.push(
      `${bought.phone_number}: DB insert ${ins.status} ${JSON.stringify(ins.body).slice(0, 160)} — NUMBER IS BOUGHT BUT UNRECORDED`,
    );
    return;
  }
  rec.row = row.id;
  // 3. ElevenLabs import (outbound) + agent (inbound).
  const label = bought.friendly_name
    ? `${bought.friendly_name} (Smile & Dial)`
    : `Smile & Dial ${bought.phone_number}`;
  const imp = await fetch(`${EL}/v1/convai/phone-numbers`, {
    method: "POST",
    headers: ELH,
    body: JSON.stringify({
      phone_number: bought.phone_number,
      label,
      provider: "twilio",
      sid: TW_ACCOUNT,
      token: env.TWILIO_AUTH_TOKEN,
    }),
  });
  const impBody = await imp.json().catch(() => ({}));
  if (!imp.ok || !impBody.phone_number_id) {
    failures.push(
      `${bought.phone_number}: ElevenLabs import ${imp.status} ${JSON.stringify(impBody).slice(0, 160)}`,
    );
  } else {
    rec.elId = impBody.phone_number_id;
    await sb(`twilio_numbers?id=eq.${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ elevenlabs_phone_number_id: rec.elId }),
    });
    const ag = await fetch(
      `${EL}/v1/convai/phone-numbers/${encodeURIComponent(rec.elId)}`,
      {
        method: "PATCH",
        headers: ELH,
        body: JSON.stringify({ agent_id: agentElId }),
      },
    );
    rec.agent = ag.ok;
    if (!ag.ok)
      failures.push(`${bought.phone_number}: agent assignment ${ag.status}`);
  }
  // 4. SHAKEN — profile first, then product (Twilio's required order). US only.
  if (country === "US") {
    const prof = await trustHub(
      "POST",
      `/CustomerProfiles/${shaken.profileSid}/ChannelEndpointAssignments`,
      { ChannelEndpointType: "phone-number", ChannelEndpointSid: bought.sid },
    );
    if (!assignedOk(prof)) {
      rec.shaken = `profile ${prof.status}`;
      failures.push(
        `${bought.phone_number}: SHAKEN profile ${prof.status} ${prof.body?.message ?? ""}`,
      );
    } else {
      const prod = await trustHub(
        "POST",
        `/TrustProducts/${shaken.trustProductSid}/ChannelEndpointAssignments`,
        { ChannelEndpointType: "phone-number", ChannelEndpointSid: bought.sid },
      );
      rec.shaken = assignedOk(prod) ? "ok" : `product ${prod.status}`;
      if (!assignedOk(prod))
        failures.push(
          `${bought.phone_number}: SHAKEN product ${prod.status} ${prod.body?.message ?? ""}`,
        );
    }
  }
}

/** Buy up to `want` numbers in ONE area code. Returns how many landed. */
async function buyInCode(region, country, ac, want) {
  if (want <= 0) return 0;
  const search = await twilio(
    "GET",
    `AvailablePhoneNumbers/${country}/Local.json?AreaCode=${ac}&PageSize=${Math.min(30, want + 5)}`,
  );
  if (!search.ok) {
    failures.push(`${region} ${ac}: search ${search.status}`);
    return 0;
  }
  // Check what came back rather than trusting Twilio's AreaCode filter.
  const candidates = (search.body.available_phone_numbers ?? []).filter(
    (n) => areaCodeOf(n.phone_number) === ac && regionOf.get(ac) === region,
  );
  let got = 0;
  for (const n of candidates) {
    if (got >= want || purchases >= MAX_PURCHASES) break;
    const buy = await twilio("POST", "IncomingPhoneNumbers.json", {
      PhoneNumber: n.phone_number,
    });
    if (!buy.ok) {
      console.log(
        `    ${n.phone_number}: purchase failed (${buy.body?.code ?? buy.status} ${buy.body?.message ?? ""}) — trying the next`,
      );
      continue;
    }
    purchases++;
    got++;
    console.log(`    bought ${buy.body.phone_number} (${region} ${ac})`);
    await afterPurchase(region, country, {
      phone_number: buy.body.phone_number,
      sid: buy.body.sid,
      friendly_name: buy.body.friendly_name ?? n.friendly_name,
    });
  }
  return got;
}

const shortfalls = [];
for (const r of plan) {
  let need = Math.max(0, r.target - (haveByRegion.get(r.region) ?? 0));
  if (need === 0) continue;
  console.log(`\n${r.region} (${r.country}) — need ${need}`);
  // Pass 1: the preferred codes at their planned counts. Pass 2: same-region
  // fallbacks, one each, so a sold-out pick still lands in a NEW code. Pass 3:
  // top up any code that still has stock.
  for (const b of r.buys) {
    if (need <= 0) break;
    need -= await buyInCode(
      r.region,
      r.country,
      b.areaCode,
      Math.min(b.count, need),
    );
  }
  const tried = new Set(r.buys.map((b) => b.areaCode));
  for (const ac of r.fallback ?? []) {
    if (need <= 0) break;
    if (tried.has(ac)) continue;
    tried.add(ac);
    need -= await buyInCode(r.region, r.country, ac, 1);
  }
  for (const ac of [...r.buys.map((b) => b.areaCode), ...(r.fallback ?? [])]) {
    if (need <= 0) break;
    need -= await buyInCode(r.region, r.country, ac, need);
  }
  if (need > 0) {
    shortfalls.push(`${r.region}: short ${need}`);
    console.log(
      `  ⚠ ${r.region} short ${need} — no inventory anywhere in the region`,
    );
  }
}

fs.writeFileSync(
  join(dirname(planPath), "buy-log.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      campaign: campaign.id,
      log,
      failures,
      shortfalls,
    },
    null,
    2,
  ),
);
console.log(`\nPurchased this run : ${purchases}`);
console.log(
  `Shortfalls         : ${shortfalls.length ? shortfalls.join(", ") : "none"}`,
);
console.log(`Failures           : ${failures.length}`);
for (const f of failures.slice(0, 40)) console.log(`  - ${f}`);
await verify(shaken);
