// Reconcile REAL Calendly bookings against the goal_met label for one Eastern
// day, in BOTH directions:
//   - goal_met with NO booking  -> likely false win (or a phantom/failed booking)
//   - booking with a NON-goal_met outcome -> a real win hiding under the wrong label
//     (could also be a phantom the AI booked without a real "yes" — read the call)
// Usage: node reconcile-bookings.js [YYYY-MM-DD]
const C = require("./_common");
const { date, start, end } = C.etWindow(process.argv[2]);

(async () => {
  const calls = await C.pageAll(
    `calls?started_at=gte.${start}&started_at=lt.${end}&select=lead_id,outcome`,
  );
  const leadIds = [...new Set(calls.map((c) => c.lead_id).filter(Boolean))];

  // outcomes seen per lead that day
  const outByLead = {};
  for (const c of calls) (outByLead[c.lead_id] = outByLead[c.lead_id] || new Set()).add(c.outcome);

  // which of those leads have a booking
  let booked = [];
  for (let i = 0; i < leadIds.length; i += 100) {
    const rows = await C.get(
      `leads?id=in.(${C.inList(leadIds.slice(i, i + 100))})&calendly_event_uri=not.is.null&select=id,company,status`,
    );
    booked = booked.concat(rows);
  }
  const bookedIds = new Set(booked.map((l) => l.id));

  const goalMetLeads = leadIds.filter((l) => outByLead[l]?.has("goal_met"));
  const goalMetNoBooking = goalMetLeads.filter((l) => !bookedIds.has(l));
  const bookedNotGoalMet = booked.filter((l) => !outByLead[l.id]?.has("goal_met"));

  console.log(`${date} (ET): ${booked.length} leads called today have a Calendly booking; ${goalMetLeads.length} leads labeled goal_met.`);
  console.log(`\nA) goal_met with NO booking (${goalMetNoBooking.length}) — likely false wins or failed bookings:`);
  for (const id of goalMetNoBooking) {
    const co = await C.get(`leads?id=eq.${id}&select=company`);
    console.log(`   ${co[0]?.company ?? id}`);
  }
  console.log(`\nB) BOOKED but NOT goal_met (${bookedNotGoalMet.length}) — a real win mislabeled, OR a phantom booking (read the call):`);
  for (const l of bookedNotGoalMet) {
    const outs = [...(outByLead[l.id] || [])].join("/");
    console.log(`   ${l.company}  [outcome=${outs}, lead.status=${l.status}]`);
  }
  console.log("\nTrue booking count = leads with a booking. Real goal_met = bookings where the DM actually agreed to attend (rule out phantoms via the transcript).");
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
