// ALL-AT-ONCE read-only sweep of one Eastern day: credit health, every outcome's
// counts + source split, booking reconciliation (both directions), and a
// transcript dump for the human-judgment outcomes. Changes NOTHING — it tells
// you what to look at; apply fixes with relabel.js after review.
// Usage: node audit-day.js [YYYY-MM-DD]   (defaults to yesterday ET)
const fs = require("fs");
const path = require("path");
const C = require("./_common");
const { date, start, end } = C.etWindow(process.argv[2]);

// Outcomes that need a human read (judgment calls). The machine outcomes
// (voicemail) and the fuzzy short-call trio (hung_up_*, no_answer) are counted
// but NOT dumped — reading them is low-value / diminishing returns.
const REVIEW = ["goal_met", "dnc", "not_interested", "gatekeeper_not_interested", "callback"];
const hhmm = (iso) =>
  new Intl.DateTimeFormat("en-US", { timeZone: C.TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const toolCalls = (t) => (Array.isArray(t) ? t : []).flatMap((x) => (x.tool_calls || []).map((tc) => tc.tool_name || tc.name || "?"));

(async () => {
  console.log(`\n========== DAILY OUTCOME SWEEP — ${date} (ET) ==========\n`);

  // 1) credit health + ai_error
  const sub = await C.elGet("user/subscription");
  const pct = sub.character_limit ? ((sub.character_count / sub.character_limit) * 100).toFixed(1) : "?";
  console.log(`ElevenLabs credits: ${pct}% used, ~${sub.character_limit - sub.character_count} left (resets ${sub.next_character_count_reset_unix ? new Date(sub.next_character_count_reset_unix * 1000).toISOString().slice(0, 10) : "?"})`);
  if (sub.character_limit && sub.character_count / sub.character_limit > 0.9) console.log("  ⚠️ >90% used — top up soon (Marija).");

  // 2) all calls for the day
  const rows = await C.pageAll(
    `calls?started_at=gte.${start}&started_at=lt.${end}&select=id,lead_id,campaign_id,outcome,outcome_source,duration_seconds,extracted_data,summary,transcript_json&order=started_at.asc`,
  );
  console.log(`\nTotal calls: ${rows.length}`);
  const byOutcome = {};
  for (const r of rows) (byOutcome[r.outcome || "null"] = byOutcome[r.outcome || "null"] || []).push(r);
  const aeCount = (byOutcome.ai_error || []).length;
  if (aeCount) console.log(`⚠️ ai_error=${aeCount} — run credit-check.js; a spike = a live credit outage.`);

  console.log(`\nOutcome                       count   manual/AI     needs review?`);
  for (const [o, rs] of Object.entries(byOutcome).sort((a, b) => b[1].length - a[1].length)) {
    const man = rs.filter((r) => r.outcome_source === "manual").length;
    const tag = REVIEW.includes(o) ? "← READ" : o === "ai_error" ? "← credit-check" : ["hung_up_immediately", "hung_up_later", "no_answer"].includes(o) ? "fuzzy: skip" : "";
    console.log(`  ${o.padEnd(28)} ${String(rs.length).padStart(4)}   ${String(man).padStart(4)}/${String(rs.length - man).padEnd(5)}  ${tag}`);
  }

  // 3) booking reconciliation (both directions)
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];
  const outByLead = {};
  for (const r of rows) (outByLead[r.lead_id] = outByLead[r.lead_id] || new Set()).add(r.outcome);
  let booked = [];
  for (let i = 0; i < leadIds.length; i += 100)
    booked = booked.concat(await C.get(`leads?id=in.(${C.inList(leadIds.slice(i, i + 100))})&calendly_event_uri=not.is.null&select=id,company,status`));
  const bookedIds = new Set(booked.map((l) => l.id));
  const goalMetLeads = leadIds.filter((l) => outByLead[l]?.has("goal_met"));
  console.log(`\nBookings: ${booked.length} leads have a Calendly booking; ${goalMetLeads.length} labeled goal_met.`);
  const falseWins = goalMetLeads.filter((l) => !bookedIds.has(l));
  const hiddenWins = booked.filter((l) => !outByLead[l.id]?.has("goal_met"));
  if (falseWins.length) console.log(`  ⚠️ ${falseWins.length} goal_met with NO booking (false wins / failed bookings) — see goal_met dump.`);
  if (hiddenWins.length) console.log(`  ⚠️ ${hiddenWins.length} booked but NOT goal_met (mislabel or phantom): ${hiddenWins.map((l) => l.company).join("; ")}`);
  if (!falseWins.length && !hiddenWins.length) console.log("  ✓ bookings and goal_met agree.");

  // 4) transcript dumps for the judgment outcomes
  console.log(`\nTranscript dumps (read these, judge against outcome-playbook.md):`);
  for (const o of REVIEW) {
    const rs = byOutcome[o];
    if (!rs || !rs.length) continue;
    const leadById = {};
    for (let i = 0; i < rs.length; i += 100) {
      const ls = await C.get(`leads?id=in.(${C.inList([...new Set(rs.map((r) => r.lead_id))].slice(i, i + 100))})&select=id,company,business_phone,status,calendly_event_uri`);
      for (const l of ls) leadById[l.id] = l;
    }
    let out = "";
    rs.forEach((r, i) => {
      const lead = leadById[r.lead_id] || {};
      const ed = r.extracted_data || {};
      out += `\n${"=".repeat(88)}\n#${i + 1} call=${r.id} dur=${r.duration_seconds}s src=${r.outcome_source} calendly=${lead.calendly_event_uri ? "YES" : "no"}\n`;
      out += `lead=${lead.company ?? "?"} status=${lead.status} dm=${ed.decision_maker_reached} tools=${toolCalls(r.transcript_json).join(",") || "-"}\n`;
      out += `summary: ${(r.summary ?? "").replace(/\s+/g, " ").trim()}\n--- transcript ---\n`;
      for (const t of r.transcript_json || []) { const m = (t.message ?? "").replace(/\s+/g, " ").trim(); if (m) out += `${t.role === "user" ? "LEAD " : "AGENT"}: ${m}\n`; }
    });
    const file = path.join(__dirname, `_out-${o}-${date}.txt`);
    fs.writeFileSync(file, out);
    console.log(`  ${o.padEnd(28)} ${String(rs.length).padStart(3)} calls -> ${path.basename(file)}`);
  }

  console.log(`\nNext: read the dumps, build a relabel map { "<callId>": "<outcome>" }, dry-run relabel.js, then --apply.`);
  console.log(`Agent-prompt changes (el-patch.js) require Marija's explicit confirmation.\n`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
