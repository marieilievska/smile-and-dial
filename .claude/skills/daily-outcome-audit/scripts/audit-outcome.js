// Pull one outcome for one Eastern day: counts, source/campaign split, booking &
// tool-call signals, and readable transcripts written to a file for review.
// Usage: node audit-outcome.js <outcome> [YYYY-MM-DD]   (date defaults to yesterday ET)
const fs = require("fs");
const path = require("path");
const C = require("./_common");

const outcome = process.argv[2];
if (!outcome) { console.error("usage: node audit-outcome.js <outcome> [YYYY-MM-DD]"); process.exit(1); }
const { date, start, end } = C.etWindow(process.argv[3]);

const toolCalls = (t) => {
  const out = [];
  if (Array.isArray(t)) for (const turn of t) for (const tc of turn.tool_calls || []) out.push(tc.tool_name || tc.name || "?");
  return out;
};

(async () => {
  const rows = await C.pageAll(
    `calls?outcome=eq.${outcome}&started_at=gte.${start}&started_at=lt.${end}` +
      `&select=id,lead_id,campaign_id,started_at,duration_seconds,outcome_source,extracted_data,summary,transcript_json&order=started_at.asc`,
  );
  console.log(`${outcome} on ${date} (ET): ${rows.length}`);
  const tally = (key, fn) => {
    const t = {};
    for (const r of rows) { const v = fn(r) ?? "null"; t[v] = (t[v] || 0) + 1; }
    console.log(`  ${key}: ${JSON.stringify(t)}`);
  };
  tally("source", (r) => r.outcome_source);
  tally("campaign", (r) => r.campaign_id);

  // lead-side signals (booking + status)
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];
  const leadById = {};
  for (let i = 0; i < leadIds.length; i += 100) {
    const ls = await C.get(`leads?id=in.(${C.inList(leadIds.slice(i, i + 100))})&select=id,company,business_phone,status,calendly_event_uri`);
    for (const l of ls) leadById[l.id] = l;
  }

  let booked = 0, bookTool = 0;
  let out = "";
  rows.forEach((r, i) => {
    const lead = leadById[r.lead_id] || {};
    const ed = r.extracted_data || {};
    const tcs = toolCalls(r.transcript_json);
    if (lead.calendly_event_uri) booked++;
    if (tcs.some((n) => /book_appointment/i.test(n))) bookTool++;
    out += `\n${"=".repeat(88)}\n#${i + 1} call=${r.id} dur=${r.duration_seconds}s src=${r.outcome_source}\n`;
    out += `lead=${lead.company ?? "?"} status=${lead.status} phone=${lead.business_phone ?? ""} calendly=${lead.calendly_event_uri ? "YES" : "no"}\n`;
    out += `disposition=${ed.disposition} dm=${ed.decision_maker_reached} email=${ed.business_email ?? ""} cbdt=${ed.callback_datetime ?? ""}\n`;
    out += `tools: ${tcs.join(", ") || "(none)"}\n`;
    out += `summary: ${(r.summary ?? "").replace(/\s+/g, " ").trim()}\n`;
    out += `--- transcript ---\n`;
    for (const t of r.transcript_json || []) {
      const role = t.role === "user" ? "LEAD " : "AGENT";
      const m = (t.message ?? "").replace(/\s+/g, " ").trim();
      if (m) out += `${role}: ${m}\n`;
    }
  });
  if (outcome === "goal_met" || bookTool)
    console.log(`  booking signal: leadHasCalendlyUri=${booked} | calledBookTool=${bookTool} / ${rows.length}`);

  const file = path.join(__dirname, `_out-${outcome}-${date}.txt`);
  fs.writeFileSync(file, out);
  console.log(`\ntranscripts -> ${file}`);
  console.log("Read that file, judge against outcome-playbook.md, then relabel.js for fixes.");
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
