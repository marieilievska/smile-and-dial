// TRIAGE — the read-only front door of the daily outcome audit. One Eastern day
// (default yesterday). Flags calls whose label contradicts a signal the AI
// already recorded so the reviewer reads the ~40 suspects instead of all 3,000,
// prints a scorecard, writes a "read these" dump + a SUGGESTED relabel map (never
// auto-applied), and rewrites one line per day into scorecard.jsonl (drift
// history). Writes nothing to the DB. Replaces the old all-at-once day sweep.
// Usage: node triage.js [YYYY-MM-DD]
const fs = require("fs");
const path = require("path");
const C = require("./_common");
const F = require("./_flags");

const { date, start, end } = C.etWindow(process.argv[2]);
const VOICEMAIL_SAMPLE = 60;

// MIRROR of src/lib/calls/outcomes.ts CONNECTED_OUTCOMES / NON_CALL_OUTCOMES —
// keep in sync. Used only for the scorecard connect-rate ratio.
const CONNECTED = new Set(["goal_met", "callback", "call_back_later", "not_interested", "gatekeeper", "gatekeeper_not_interested", "transferred_to_human", "language_barrier", "hung_up_immediately", "hung_up_later", "dnc"]);
const NON_CALL = new Set(["ai_error"]);

/** Evenly-spaced deterministic sample (reproducible — no Math.random). */
const evenSample = (arr, n) => (arr.length <= n ? arr.slice() : Array.from({ length: n }, (_, i) => arr[Math.floor((i * arr.length) / n)]));

(async () => {
  console.log(`\n===== TRIAGE — ${date} (ET) =====`);

  // 1) light pull (no transcript_json)
  const rows = await C.pageAll(
    `calls?started_at=gte.${start}&started_at=lt.${end}` +
      `&select=id,lead_id,campaign_id,outcome,outcome_source,duration_seconds,status,extracted_data,started_at,elevenlabs_conversation_id&order=started_at.asc`,
  );
  const byOutcome = {};
  for (const r of rows) (byOutcome[r.outcome || "(null)"] = byOutcome[r.outcome || "(null)"] || []).push(r);
  console.log(`total calls: ${rows.length}`);

  // 2) leads → booking set + per-lead outcome sets
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];
  const booked = new Set();
  for (let i = 0; i < leadIds.length; i += 100) {
    const ls = await C.get(`leads?id=in.(${C.inList(leadIds.slice(i, i + 100))})&calendly_event_uri=not.is.null&select=id`);
    for (const l of ls) booked.add(l.id);
  }
  const outByLead = {};
  for (const r of rows) (outByLead[r.lead_id] = outByLead[r.lead_id] || new Set()).add(r.outcome);

  // 3) callbacks rows for this day's callback calls (strand detection)
  const callbackIds = (byOutcome.callback || []).map((r) => r.id);
  const hasCb = new Set();
  for (let i = 0; i < callbackIds.length; i += 100) {
    const cbs = await C.get(`callbacks?originating_call_id=in.(${C.inList(callbackIds.slice(i, i + 100))})&select=originating_call_id`);
    for (const c of cbs) hasCb.add(c.originating_call_id);
  }

  // 4) structural flags (no transcript)
  const flags = [];
  for (const r of rows) {
    for (const f of F.structuralFlags({ outcome: r.outcome, extracted: r.extracted_data, leadHasBooking: booked.has(r.lead_id), hasCallbackRow: hasCb.has(r.id), status: r.status })) {
      flags.push({ id: r.id, lead_id: r.lead_id, outcome: r.outcome, ...f });
    }
  }
  // hidden wins: booked leads whose day outcomes lack goal_met
  const hiddenWins = [...booked].filter((l) => !outByLead[l] || !outByLead[l].has("goal_met"));

  // 5) transcript flags: all dnc + a voicemail sample
  const dncRows = byOutcome.dnc || [];
  const vmRows = byOutcome.voicemail || [];
  const vmSample = evenSample(vmRows, VOICEMAIL_SAMPLE);
  const tIds = [...dncRows.map((r) => r.id), ...vmSample.map((r) => r.id)];
  const tById = {};
  for (let i = 0; i < tIds.length; i += 60) {
    const ts = await C.get(`calls?id=in.(${C.inList(tIds.slice(i, i + 60))})&select=id,transcript_json`);
    for (const t of ts) tById[t.id] = t.transcript_json;
  }
  for (const r of [...dncRows, ...vmSample]) {
    for (const f of F.transcriptFlags({ outcome: r.outcome, transcript: tById[r.id] })) {
      flags.push({ id: r.id, lead_id: r.lead_id, outcome: r.outcome, ...f });
    }
  }

  // 6) scorecard
  const flagByType = {};
  for (const f of flags) flagByType[f.type] = (flagByType[f.type] || 0) + 1;
  const cnt = (o) => (byOutcome[o] || []).length;
  const total = rows.length || 1;
  const connected = rows.filter((r) => CONNECTED.has(r.outcome)).length;
  const denom = rows.filter((r) => !NON_CALL.has(r.outcome)).length || 1;
  const niDenom = cnt("not_interested") || 1;
  const ratios = {
    not_interested_dm_no: +((flagByType.not_interested_dm_not_yes || 0) / niDenom).toFixed(3),
    ai_receptionist_share: +(cnt("ai_receptionist") / total).toFixed(3),
    callback_share: +(cnt("callback") / total).toFixed(3),
    connect_rate: +(connected / denom).toFixed(3),
    goal_met: cnt("goal_met"),
    dnc: cnt("dnc"),
  };

  const flagsForOutcome = (o) => flags.filter((f) => f.outcome === o).length;
  console.log(`\noutcome                        count   manual   flags`);
  for (const [o, rs] of Object.entries(byOutcome).sort((a, b) => b[1].length - a[1].length)) {
    const man = rs.filter((r) => r.outcome_source === "manual").length;
    console.log(`  ${o.padEnd(28)} ${String(rs.length).padStart(5)}  ${String(man).padStart(6)}  ${String(flagsForOutcome(o)).padStart(5)}`);
  }
  console.log(`\nflags by type: ${JSON.stringify(flagByType)}`);
  console.log(`hidden-win goal_met (booked, not goal_met): ${hiddenWins.length}`);
  console.log(`voicemail: sampled ${vmSample.length} of ${vmRows.length} (skipped ${vmRows.length - vmSample.length})`);
  if ((byOutcome.ai_error || []).length) console.log(`⚠️ ai_error=${(byOutcome.ai_error || []).length} — run credit-check.js (incident, not a relabel).`);
  console.log(`ratios: ${JSON.stringify(ratios)}`);

  // 7) drift check vs trailing baseline, then idempotent scorecard write
  const D = require("./_drift");
  const scFile = path.join(__dirname, "scorecard.jsonl");
  const scorecard = { date, total: rows.length, byOutcome: Object.fromEntries(Object.entries(byOutcome).map(([o, rs]) => [o, rs.length])), flags: flagByType, ratios };
  const priorLines = fs.existsSync(scFile) ? fs.readFileSync(scFile, "utf8").split("\n").filter(Boolean) : [];
  const priorScorecards = priorLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const drift = D.driftReport({ today: scorecard, history: priorScorecards });
  console.log(`\ndrift vs trailing baseline (${drift.priorDays} prior day${drift.priorDays === 1 ? "" : "s"}):`);
  if (drift.baselineBuilding) {
    console.log(`  baseline building — need ≥2 prior audited days for a drift check.`);
  } else if (!drift.flags.length) {
    console.log(`  ✓ no watched metric moved beyond its threshold.`);
  } else {
    for (const f of drift.flags) console.log(`  ⚠️ DRIFT: ${D.fmt(f)} — check for an agent/campaign change.`);
  }
  // idempotent write: drop any existing line for this date, add today's, and keep
  // the file in canonical chronological order so re-running a day is a no-op diff.
  const kept = priorLines.filter((l) => { try { return JSON.parse(l).date !== date; } catch { return false; } });
  kept.push(JSON.stringify(scorecard));
  kept.sort((a, b) => { try { return JSON.parse(a).date < JSON.parse(b).date ? -1 : 1; } catch { return 0; } });
  fs.writeFileSync(scFile, kept.join("\n") + "\n");

  // 8) READ-THESE dump (flagged + all dnc + all goal_met) + suggested relabel map
  const wantRead = new Map();
  const addRead = (id, outcome, reason) => {
    const e = wantRead.get(id) || { outcome, reasons: [] };
    e.reasons.push(reason);
    wantRead.set(id, e);
  };
  for (const f of flags) addRead(f.id, f.outcome, `${f.type}: ${f.reason}`);
  for (const r of dncRows) addRead(r.id, "dnc", "always-read: all dnc");
  for (const r of byOutcome.goal_met || []) addRead(r.id, "goal_met", "always-read: all goal_met");

  const readIds = [...wantRead.keys()];
  const dumpById = {};
  for (let i = 0; i < readIds.length; i += 60) {
    const ds = await C.get(`calls?id=in.(${C.inList(readIds.slice(i, i + 60))})&select=id,duration_seconds,outcome_source,summary,transcript_json,lead_id`);
    for (const d of ds) dumpById[d.id] = d;
  }
  const leadOfRead = [...new Set(readIds.map((id) => dumpById[id] && dumpById[id].lead_id).filter(Boolean))];
  const leadById = {};
  for (let i = 0; i < leadOfRead.length; i += 100) {
    const ls = await C.get(`leads?id=in.(${C.inList(leadOfRead.slice(i, i + 100))})&select=id,company,status,calendly_event_uri`);
    for (const l of ls) leadById[l.id] = l;
  }
  let out = `TRIAGE READ LIST — ${date} (ET) — ${readIds.length} calls (flagged + all dnc + all goal_met)\n`;
  for (const [id, meta] of wantRead) {
    const d = dumpById[id] || {};
    const lead = leadById[d.lead_id] || {};
    out += `\n${"=".repeat(88)}\ncall=${id} outcome=${meta.outcome} dur=${d.duration_seconds}s src=${d.outcome_source} lead=${lead.company ?? "?"} calendly=${lead.calendly_event_uri ? "YES" : "no"}\n`;
    out += `WHY: ${meta.reasons.join(" | ")}\n`;
    out += `summary: ${(d.summary ?? "").replace(/\s+/g, " ").trim()}\n--- transcript ---\n`;
    for (const t of d.transcript_json || []) {
      const m = (t.message ?? "").replace(/\s+/g, " ").trim();
      if (m) out += `${t.role === "user" ? "LEAD " : "AGENT"}: ${m}\n`;
    }
  }
  const dumpFile = path.join(__dirname, `_out-triage-${date}.txt`);
  fs.writeFileSync(dumpFile, out);

  // suggested map — high-confidence structural suggestions only; gitignored (map*.json)
  const suggested = {};
  for (const f of flags) if (f.suggest) suggested[f.id] = { to: f.suggest, from: f.outcome };
  const mapFile = path.join(__dirname, `map-triage-${date}.json`);
  fs.writeFileSync(mapFile, JSON.stringify(suggested, null, 2));

  console.log(`\nREAD:  ${path.basename(dumpFile)}  (${readIds.length} calls)`);
  console.log(`MAP:   ${path.basename(mapFile)}  (${Object.keys(suggested).length} high-confidence — review, then: node relabel.js ${path.basename(mapFile)}  → --apply)`);
  console.log(`scorecard.jsonl updated for ${date}.`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
