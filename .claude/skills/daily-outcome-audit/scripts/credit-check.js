// ElevenLabs credit health + ai_error incident check. ai_error == the workspace
// hit its credit ceiling and EL killed calls ("exceeds your quota limit").
// Usage:
//   node credit-check.js                 # balance + today's ai_error picture
//   node credit-check.js --day 2026-08-11
//   node credit-check.js --reschedule [--day D] [--apply]   # pull leads a spike pushed out
const C = require("./_common");

const arg = (f) => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : null;
};
const has = (f) => process.argv.includes(f);
const day = arg("--day") || C.etDate(0); // default TODAY (a spike is usually live)
const { start, end } = C.etWindow(day);
const hhmm = (iso) =>
  new Intl.DateTimeFormat("en-US", { timeZone: C.TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

(async () => {
  // 1) credit balance
  const sub = await C.elGet("user/subscription");
  const used = sub.character_count, lim = sub.character_limit;
  const pct = lim ? ((used / lim) * 100).toFixed(1) : "?";
  console.log(`ElevenLabs: tier=${sub.tier} status=${sub.status}`);
  console.log(`  credits ${used}/${lim} = ${pct}% used, ~${lim - used} left` +
    (sub.next_character_count_reset_unix ? `, resets ${new Date(sub.next_character_count_reset_unix * 1000).toISOString().slice(0, 10)}` : ""));
  if (lim && used / lim > 0.9) console.log("  ⚠️ >90% used — outbound will start quota-failing soon. Only Marija can top up.");

  // 2) ai_error picture for the day
  const ae = await C.pageAll(
    `calls?outcome=eq.ai_error&started_at=gte.${start}&started_at=lt.${end}&select=id,started_at,duration_seconds,elevenlabs_conversation_id,lead_id&order=started_at.asc`,
  );
  console.log(`\nai_error on ${day} (ET): ${ae.length}`);
  if (ae.length) {
    console.log(`  first ${hhmm(ae[0].started_at)}  last ${hhmm(ae[ae.length - 1].started_at)} ET`);
    const instant = ae.filter((c) => (c.duration_seconds || 0) <= 2).length;
    console.log(`  instant-fail (<=2s, account dry): ${instant} | live-cutoff (>2s): ${ae.length - instant}`);
    // verify the label against EL's real termination_reason on a sample
    console.log("  sample termination_reason:");
    for (const c of ae.slice(-3)) {
      const conv = await C.elGet(`convai/conversations/${c.elevenlabs_conversation_id}`).catch(() => null);
      console.log(`    ${hhmm(c.started_at)} :: ${String(conv?.metadata?.termination_reason || "?").slice(0, 70)}`);
    }
  }

  // 3) optional: reschedule leads a spike pushed out
  if (has("--reschedule")) {
    const now = new Date().toISOString();
    const leadIds = [...new Set(ae.map((c) => c.lead_id).filter(Boolean))];
    // latest call that day per lead
    const latest = {};
    for (let i = 0; i < leadIds.length; i += 80) {
      const rows = await C.pageAll(
        `calls?lead_id=in.(${C.inList(leadIds.slice(i, i + 80))})&started_at=gte.${start}&started_at=lt.${end}&select=lead_id,outcome,started_at`,
      );
      for (const r of rows) if (!latest[r.lead_id] || r.started_at > latest[r.lead_id].started_at) latest[r.lead_id] = r;
    }
    const stuck = leadIds.filter((l) => latest[l]?.outcome === "ai_error");
    let eligible = [];
    for (let i = 0; i < stuck.length; i += 100) {
      const rows = await C.get(
        `leads?id=in.(${C.inList(stuck.slice(i, i + 100))})&select=id,status,next_call_at,company`,
      );
      for (const l of rows) {
        if ((l.status === "ready_to_call" || l.status === "resting") && l.next_call_at && Date.parse(l.next_call_at) > Date.now())
          eligible.push(l);
      }
    }
    console.log(`\n[reschedule] leads pushed out by the spike: ${eligible.length}`);
    if (!has("--apply")) { console.log("  (dry-run — pass --apply)"); return; }
    for (let i = 0; i < eligible.length; i += 60) {
      await C.patch(`leads?id=in.(${C.inList(eligible.slice(i, i + 60).map((l) => l.id))})`,
        { next_call_at: now, status: "ready_to_call", resting_until: null, updated_at: now });
    }
    console.log(`  rescheduled ${eligible.length} leads to now.`);
  }
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
