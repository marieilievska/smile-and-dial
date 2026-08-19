// One-off recovery: book the leads whose Calendly registration was rejected by
// the "Required Questions and Answers cannot be blank." outage (2026-08-18/19).
// Mirrors the app's live booking path exactly (location + required-question
// answers + UTM tracking + calendly_events row + lead status).
// Dry-run by default:  node recover-failed-bookings.js [--apply]
const C = require("./_common");
const APPLY = process.argv.includes("--apply");

// Judged one by one from the full transcript. Only people who gave a clear
// affirmative to attending the Aug 27 session are listed here.
const RECOVER = [
  ["ba5a0c16", "Elektra", "eeaygee0621@gmail.com"],
  ["b842b738", "Nga", "nnga198012@gmail.com"],
  ["67022474", "Jenna", "jenna@alchemy43.com"],
  ["a50b3938", "John", "contact@wilfit.com"],
  ["ccd267d8", "Dawn", "b4dawnnaturalhairstudio@gmail.com"],
  ["f78eb73e", "Roberta", "alaskahealingarts@gmail.com"],
  ["37f56ae5", "Sachi", "lanirashes2021@gmail.com"],
  ["b0e12ef5", "Trina", "spadelamer.nl@gmail.com"],
  ["529e01c1", "Rhonda", "ontrackphysio@eastlink.ca"],
  ["5c6d464f", "Heather", "healingjourneynl@gmail.com"],
  ["2b155c60", "Yamillet", "yami_orta@yahoo.com"],
  ["cf783082", "Polo", "suprememanolofl@gmail.com"],
  ["0221b714", "Julia", "asyouwishbarbershop@gmail.com"],
  ["0314ebb5", "Raul", "bodiedbymercury@gmail.com"],
  ["4fd8495d", "Tina", "tinaphan223@yahoo.com"],
  ["893690ba", "Cecilia", "totalskinct@gmail.com"],
  ["7699ba32", "Tracy", "tnops.danver@handandstone.com"],
  ["0ec752d5", "Adrieanne", "adrienne@jonalansalon.com"],
  ["d260eac2", "Carlos", "meneses.carlos.a@gmail.com"],
  ["8f32920a", "Mike", "cy-fairwest@f45training.com"],
];

// Deliberately EXCLUDED. Never register someone who did not agree to attend.
const EXCLUDED = [
  ["d67324ab", "RE5 Wellness (Remedy)", "agreed to a mis-stated 10am Pacific, then rejected the REAL local time: 7 AM will not work for me."],
  ["397db799", "Rainbow Nails (Rose)", "never confirmed: not sure about that, send me an email and I will double-check."],
  ["b82a2e5d", "Homeopathic Health Plus (Sue)", "WITHDREW at the end of the call: I am not interested in it, thank you."],
];

const CAMPAIGN = "3cd40c9c-5a42-4476-9ef1-c6a1e0fc72d8";
const COMPANY_Q = /company|business|practice|studio|salon|clinic|shop|firm|brand|organi[sz]ation/i;

(async () => {
  const camp = (await C.get(`campaigns?id=eq.${CAMPAIGN}&select=owner_id,name,calendly_event_id`))[0];
  const et = (await C.get(`calendly_event_types?id=eq.${camp.calendly_event_id}&select=event_uri`))[0];
  const token = ((await C.get(`user_integrations?user_id=eq.${camp.owner_id}&select=calendly_api_key`))[0].calendly_api_key || "").trim();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Host config, read live (locations + required questions) — same as the app.
  const cfg = await (await fetch(et.event_uri, { headers: auth })).json();
  const locations = cfg.resource?.locations ?? [];
  const questions = cfg.resource?.custom_questions ?? [];
  const required = questions.filter((q) => q.enabled !== false && q.required === true);
  console.log(`event:    ${String(cfg.resource?.name).trim()}`);
  console.log(`location: ${JSON.stringify(locations[0])}`);
  console.log(`required: ${required.map((q) => q.name).join(", ") || "(none)"}`);

  // The session everyone agreed to: the next open one (Aug 27).
  const openAt = async (fromDays, toDays) => {
    const url = `https://api.calendly.com/event_type_available_times?event_type=${encodeURIComponent(et.event_uri)}` +
      `&start_time=${new Date(Date.now() + fromDays * 864e5).toISOString()}` +
      `&end_time=${new Date(Date.now() + toDays * 864e5).toISOString()}`;
    const j = await (await fetch(url, { headers: auth })).json();
    return (j.collection || [])[0]?.start_time;
  };
  const start = (await openAt(0.05, 6)) || (await openAt(6, 12)) || (await openAt(12, 18));
  if (!start) {
    console.error("NO OPEN SLOT in the next 18 days — aborting.");
    process.exit(1);
  }
  console.log(`session:  ${start}\n`);

  console.log("EXCLUDED (did not consent):");
  for (const [id, who, why] of EXCLUDED) console.log(`  x ${id}  ${who} — ${why}`);
  console.log("");

  // Resolve the 8-char prefixes to real call rows. PostgREST cannot LIKE a uuid
  // column, so pull the affected calls (the ones that logged a booking error)
  // and match by prefix here.
  const errEvents = await C.pageAll("system_events?kind=eq.tool_book_appointment&select=ref_id,payload");
  const affected = [...new Set(errEvents.filter((e) => e.payload && e.payload.error).map((e) => e.ref_id))];
  const affectedCalls = await C.pageAll(
    `calls?id=in.(${affected.map((i) => `"${i}"`).join(",")})&select=id,lead_id`);
  const byPrefix = Object.fromEntries(affectedCalls.map((c) => [c.id.slice(0, 8), c]));

  let ok = 0, skipped = 0, failed = 0;
  for (const [short, name, email] of RECOVER) {
    const call = byPrefix[short];
    if (!call) { console.log(`  ? ${name} — call ${short} not found`); failed++; continue; }
    const lead = (await C.get(`leads?id=eq.${call.lead_id}&select=id,company,owner_id,timezone,status`))[0];

    // Never double-book: same guard as the app.
    const existing = await C.get(
      `calendly_events?lead_id=eq.${lead.id}&status=eq.scheduled&select=scheduled_at`);
    if ((existing || []).some((b) => new Date(b.scheduled_at).getTime() === new Date(start).getTime())) {
      console.log(`  = ${name.padEnd(10)} ${lead.company} — already booked, skipping`);
      skipped++; continue;
    }

    const qa = required.map((q) => ({
      question: q.name,
      answer: COMPANY_Q.test(q.name)
        ? (lead.company || name)
        : /e-?mail/i.test(q.name)
          ? email
          : (lead.company || name),
      position: typeof q.position === "number" ? q.position : 0,
    }));

    const body = {
      event_type: et.event_uri,
      start_time: start,
      invitee: { name, email, timezone: lead.timezone || "America/New_York" },
      ...(locations[0]?.kind ? { location: { kind: locations[0].kind } } : {}),
      ...(qa.length ? { questions_and_answers: qa } : {}),
      tracking: {
        utm_source: "smile_dial",
        utm_medium: "voice",
        utm_campaign: "voice_ai_webinar_27",
        utm_content: "recovered_booking",
        utm_term: "voice_ai",
        salesforce_uuid: lead.id,
      },
    };

    if (!APPLY) {
      console.log(`  + ${name.padEnd(10)} ${String(lead.company).slice(0, 30).padEnd(31)} ${email.padEnd(36)} answer=${JSON.stringify(qa.map((x) => x.answer))}`);
      ok++; continue;
    }

    // Calendly rate-limits the Scheduling API; back off and retry rather than
    // dropping a real person's seat on the floor.
    let res, data, detail;
    for (let attempt = 1; attempt <= 5; attempt++) {
      res = await fetch("https://api.calendly.com/invitees", { method: "POST", headers: auth, body: JSON.stringify(body) });
      const raw = await res.text();
      try { data = JSON.parse(raw); } catch { data = null; }
      detail = (data?.details || []).map((d) => `${d.parameter ?? ""} ${d.message ?? ""}`.trim()).join(", ")
        || data?.message || data?.title || `HTTP ${res.status}: ${raw.slice(0, 200)}`;
      if (res.ok) break;
      if (res.status === 429 || res.status >= 500) {
        const wait = 2000 * attempt;
        console.log(`     ...${res.status} on ${name}, retrying in ${wait}ms (attempt ${attempt}/5)`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      break;
    }
    if (!res.ok) {
      console.log(`  x ${name.padEnd(10)} ${lead.company} — ${detail}`);
      failed++; continue;
    }
    // Gentle pacing so we stop tripping the limiter in the first place.
    await new Promise((r) => setTimeout(r, 1200));
    await C.post("calendly_events", {
      owner_id: lead.owner_id,
      lead_id: lead.id,
      invitee_uri: data.resource?.uri,
      event_uri: data.resource?.event ?? "",
      event_type_uri: et.event_uri,
      invitee_email: email,
      invitee_name: name,
      scheduled_at: new Date(start).toISOString(),
      status: "scheduled",
    });
    await C.patch(`leads?id=eq.${lead.id}`, { status: "scheduled", calendly_event_uri: data.resource?.event ?? null });
    await C.post("system_events", {
      kind: "tool_book_appointment",
      ref_table: "calls",
      ref_id: call.id,
      actor_user_id: null,
      payload: { live: true, email, slot_id: start, invitee_uri: data.resource?.uri, recovered: true,
        note: "manual recovery of a booking lost to the required-questions outage" },
    });
    console.log(`  v ${name.padEnd(10)} ${lead.company} — booked`);
    ok++;
  }
  console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"} — booked=${ok} skipped=${skipped} failed=${failed}`);
  if (!APPLY) console.log("(pass --apply to actually create these registrations)");
})();
