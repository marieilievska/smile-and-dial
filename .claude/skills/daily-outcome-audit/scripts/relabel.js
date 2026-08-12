// Safely relabel calls AND move each lead's state to match the new outcome.
// Dry-run by default. Refuses any call whose current outcome isn't what you
// expect (pass expected via the map), and blocks un-DNC unless the lead is
// DNC-clean.
//
// Map file (JSON): { "<callId>": "<targetOutcome>", ... }
//   or per-call object: { "<callId>": { "to":"callback", "from":"goal_met",
//                          "scheduled_at":"2026-08-27T17:00:00Z" } }
// Usage:
//   node relabel.js map.json                       # dry-run
//   node relabel.js map.json --apply
//   node relabel.js map.json --apply --allow-undnc # required to reverse a dnc
const fs = require("fs");
const C = require("./_common");

const mapPath = process.argv[2];
if (!mapPath) { console.error("usage: node relabel.js <map.json> [--apply] [--allow-undnc]"); process.exit(1); }
const APPLY = process.argv.includes("--apply");
const ALLOW_UNDNC = process.argv.includes("--allow-undnc");
const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();
const nowIso = iso(now);

/** Lead patch mirroring retry-engine.ts for a target outcome. */
function leadPatch(to, spec) {
  const base = { updated_at: nowIso };
  switch (to) {
    case "gatekeeper":
    case "voicemail": case "no_answer": case "busy": case "failed":
    case "hung_up_immediately": case "hung_up_later":
      return { ...base, status: "ready_to_call", next_call_at: iso(now + 2 * DAY), resting_until: null };
    case "ai_error":
      return { ...base, status: "ready_to_call", next_call_at: iso(now + 2 * 3600000), resting_until: null };
    case "gatekeeper_not_interested":
      return { ...base, status: "resting", resting_until: iso(now + 15 * DAY), next_call_at: iso(now + 15 * DAY), retry_counter: 0, retry_position: 0, call_back_later_count: 0 };
    case "not_interested":
      return { ...base, status: "resting", resting_until: iso(now + 30 * DAY), next_call_at: iso(now + 30 * DAY), retry_counter: 0, retry_position: 0, call_back_later_count: 0 };
    case "goal_met":
      return { ...base, status: "goal_met", next_call_at: null, resting_until: null };
    case "callback":
      if (!spec.scheduled_at) throw new Error("callback target needs scheduled_at");
      return { ...base, status: "callback", next_call_at: spec.scheduled_at, resting_until: null };
    default:
      throw new Error("no lead-state rule for target: " + to);
  }
}

async function dncClean(leadId, callId) {
  const leadCalls = await C.get(`calls?lead_id=eq.${leadId}&select=id,outcome`);
  const dncCalls = leadCalls.filter((c) => c.outcome === "dnc");
  const okCalls = dncCalls.length === 1 && dncCalls[0].id === callId;
  const lead = (await C.get(`leads?id=eq.${leadId}&select=business_phone`))[0] || {};
  const ids = leadCalls.map((c) => c.id);
  const byCall = await C.get(`dnc_entries?source_call_id=in.(${C.inList(ids)})&select=id,source_call_id`);
  const byPhone = lead.business_phone
    ? await C.get(`dnc_entries?phone=eq.${encodeURIComponent(lead.business_phone)}&select=id,source_call_id`)
    : [];
  const entries = [...byCall, ...byPhone];
  const stray = entries.some((e) => e.source_call_id && e.source_call_id !== callId);
  return { ok: okCalls && !stray, entries: [...new Map(entries.map((e) => [e.id, e])).values()] };
}

(async () => {
  const ids = Object.keys(map);
  const calls = await C.get(`calls?id=in.(${C.inList(ids)})&select=id,lead_id,campaign_id,outcome`);
  const byId = {}; for (const c of calls) byId[c.id] = c;

  let planned = 0, skipped = 0;
  const actions = [];
  for (const callId of ids) {
    const spec = typeof map[callId] === "string" ? { to: map[callId] } : map[callId];
    const c = byId[callId];
    if (!c) { console.log(`SKIP ${callId}: not found`); skipped++; continue; }
    if (spec.from && c.outcome !== spec.from) { console.log(`SKIP ${callId}: outcome is ${c.outcome}, expected ${spec.from}`); skipped++; continue; }
    let undnc = null;
    if (c.outcome === "dnc") {
      if (!ALLOW_UNDNC) { console.log(`SKIP ${callId}: reversing a dnc needs --allow-undnc`); skipped++; continue; }
      undnc = await dncClean(c.lead_id, callId);
      if (!undnc.ok) { console.log(`SKIP ${callId}: NOT DNC-clean (stray dnc signal) — leaving on dnc`); skipped++; continue; }
    }
    let lp;
    try { lp = leadPatch(spec.to, spec); } catch (e) { console.log(`SKIP ${callId}: ${e.message}`); skipped++; continue; }
    console.log(`${c.outcome} -> ${spec.to}  call=${callId} lead=${c.lead_id} => lead.status=${lp.status}${undnc ? ` (+delete ${undnc.entries.length} dnc_entries)` : ""}${spec.scheduled_at ? ` @${spec.scheduled_at}` : ""}`);
    actions.push({ callId, c, spec, lp, undnc });
    planned++;
  }
  console.log(`\nplanned=${planned} skipped=${skipped}`);
  if (!APPLY) { console.log("(dry-run — pass --apply)"); return; }

  for (const a of actions) {
    // Keep the goal_met BOOLEAN column in sync with the outcome — it's a
    // separate column the Leads strip + Analytics count on, and forgetting it
    // leaves a downgraded call still reading as a "goal met" (the 111-vs-53 bug).
    await C.patch(`calls?id=eq.${a.callId}`, {
      outcome: a.spec.to,
      outcome_source: "manual",
      goal_met: a.spec.to === "goal_met",
      retry_applied_at: null,
    });
    if (a.spec.to === "callback") {
      await C.post("callbacks", { lead_id: a.c.lead_id, campaign_id: a.c.campaign_id, originating_call_id: a.callId, scheduled_at: a.spec.scheduled_at, status: "pending", voicemail_attempts: 0 });
    }
    if (a.undnc) for (const e of a.undnc.entries) await C.del(`dnc_entries?id=eq.${e.id}`);
    await C.patch(`leads?id=eq.${a.c.lead_id}`, a.lp);
  }
  console.log(`applied ${actions.length} relabels.`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
