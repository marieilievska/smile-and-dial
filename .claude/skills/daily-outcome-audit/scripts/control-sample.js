// CALIBRATION control sample — the "did triage MISS anything?" check. Read-only.
// Dumps a spread sample of CONNECTED conversation calls that triage did NOT flag
// (and aren't in the always-read goal_met bucket, nor already human-corrected).
// Read these for MISSED mislabels: if one is wrong, triage has a blind spot —
// add or widen a flag in _flags.js and re-run. This is recall (coverage); triage
// itself gives precision (are the flags right).
// Usage: node control-sample.js [YYYY-MM-DD] [N]   (N default 25; date = yesterday ET)
const fs = require("fs");
const path = require("path");
const C = require("./_common");
const F = require("./_flags");

const { date, start, end } = C.etWindow(process.argv[2]);
const N = parseInt(process.argv[3], 10) || 25;

// MIRROR of src/lib/calls/outcomes.ts CONVERSATION_OUTCOMES — a real two-way
// human conversation (where a missed mislabel would actually matter).
const CONVERSATION = new Set(["goal_met", "callback", "not_interested", "gatekeeper", "gatekeeper_not_interested", "transferred_to_human", "language_barrier"]);
// triage already reads ALL goal_met (and all dnc, which isn't a conversation outcome).
const ALWAYS_READ = new Set(["goal_met"]);

/** Evenly-spaced deterministic sample across the whole day (reproducible, unbiased). */
const evenSample = (arr, n) => (arr.length <= n ? arr.slice() : Array.from({ length: n }, (_, i) => arr[Math.floor((i * arr.length) / n)]));

(async () => {
  const rows = await C.pageAll(
    `calls?started_at=gte.${start}&started_at=lt.${end}&select=id,lead_id,outcome,outcome_source,extracted_data,status,duration_seconds,summary&order=started_at.asc`,
  );

  // Booking + callbacks context, so "flagged" matches triage exactly.
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];
  const booked = new Set();
  for (let i = 0; i < leadIds.length; i += 100)
    for (const l of await C.get(`leads?id=in.(${C.inList(leadIds.slice(i, i + 100))})&calendly_event_uri=not.is.null&select=id`)) booked.add(l.id);
  const callbackIds = rows.filter((r) => r.outcome === "callback").map((r) => r.id);
  const hasCb = new Set();
  for (let i = 0; i < callbackIds.length; i += 100)
    for (const c of await C.get(`callbacks?originating_call_id=in.(${C.inList(callbackIds.slice(i, i + 100))})&select=originating_call_id`)) hasCb.add(c.originating_call_id);

  const isFlagged = (r) =>
    F.structuralFlags({ outcome: r.outcome, extracted: r.extracted_data, leadHasBooking: booked.has(r.lead_id), hasCallbackRow: hasCb.has(r.id), status: r.status }).length > 0;

  // The pool triage said nothing about: a human conversation, not flagged, not
  // an always-read bucket, not already hand-corrected.
  const pool = rows.filter(
    (r) => CONVERSATION.has(r.outcome) && !ALWAYS_READ.has(r.outcome) && r.outcome_source !== "manual" && !isFlagged(r),
  );
  const sample = evenSample(pool, N);
  console.log(`${date} (ET): ${rows.length} calls | conversation-unflagged pool ${pool.length} | control sample ${sample.length}`);
  if (!pool.length) {
    console.log("  (nothing to sample — no unflagged conversation calls this day.)");
    return;
  }

  const ids = sample.map((r) => r.id);
  const tById = {};
  for (let i = 0; i < ids.length; i += 60)
    for (const d of await C.get(`calls?id=in.(${C.inList(ids.slice(i, i + 60))})&select=id,transcript_json`)) tById[d.id] = d.transcript_json;
  const leadById = {};
  const sLeadIds = [...new Set(sample.map((r) => r.lead_id).filter(Boolean))];
  for (let i = 0; i < sLeadIds.length; i += 100)
    for (const l of await C.get(`leads?id=in.(${C.inList(sLeadIds.slice(i, i + 100))})&select=id,company`)) leadById[l.id] = l;

  let out = `CONTROL SAMPLE — ${date} (ET) — ${sample.length} of ${pool.length} unflagged conversation calls\n`;
  out += `Read for MISSED mislabels. Each was NOT flagged by triage. If one is wrong, add/widen a flag in _flags.js and re-run; log it in calibration.md.\n`;
  sample.forEach((r, i) => {
    const ed = r.extracted_data || {};
    const lead = leadById[r.lead_id] || {};
    out += `\n${"=".repeat(88)}\n#${i + 1} call=${r.id} outcome=${r.outcome} dur=${r.duration_seconds}s dm=${ed.decision_maker_reached} lead=${lead.company ?? "?"}\n`;
    out += `summary: ${(r.summary ?? "").replace(/\s+/g, " ").trim()}\n--- transcript ---\n`;
    for (const t of tById[r.id] || []) {
      const m = (t.message ?? "").replace(/\s+/g, " ").trim();
      if (m) out += `${t.role === "user" ? "LEAD " : "AGENT"}: ${m}\n`;
    }
  });
  const file = path.join(__dirname, `_out-control-${date}.txt`);
  fs.writeFileSync(file, out);
  console.log(`\nRead: ${path.basename(file)} — verify triage MISSED nothing. Record the result in calibration.md.`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
