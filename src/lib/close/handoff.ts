/**
 * Build the plain-text Note we post onto a Close lead when an operator hands the
 * lead to a closer. Pure + deterministic (no I/O, no `server-only`) so it can be
 * unit-tested. Lines with no data are omitted. Times render in the LEAD's
 * timezone so the closer reads the appointment the way the customer agreed to it.
 */
export type HandoffNoteInput = {
  lead: {
    company: string | null;
    ownerName: string | null;
    managerName: string | null;
    employeeName: string | null;
    businessPhone: string | null;
    businessEmail: string | null;
    timezone: string | null;
    city: string | null;
    state: string | null;
  };
  calls: {
    startedAt: string | null;
    outcome: string | null;
    summary: string | null;
    recordingUrl: string | null;
  }[];
  leadResponseTime: string | null;
  decisionMakerReached: string | null;
  appointment: { scheduledAt: string | null; eventLink: string | null } | null;
  /** The rolling, cross-call digest of what the lead actually said / wants (from
   *  lead_campaign_summaries.ai_summary), already trimmed of any AI-facing tail.
   *  Null when we have no summary. This is the closer's main context. */
  contextSummary: string | null;
  customFields: { label: string; value: string }[];
};

export type CallKeyAnswerSource = {
  extractedData: Record<string, unknown> | null;
};

/**
 * Choose the handoff note's KEY ANSWERS from ALL of a lead's calls (passed
 * NEWEST-FIRST), rather than trusting the single newest call that happens to
 * carry extracted data. A short follow-up call's extraction is often noisy —
 * e.g. it reports `decision_maker_reached: "no"` because that call only reached
 * a gatekeeper — and previously that overwrote an earlier call that DID reach
 * the owner, so the note told the closer the decision-maker wasn't reached when
 * they were. Rules: a "reached = yes" on ANY call wins (you don't un-reach a
 * decision-maker on a later call); each free-text answer is the most recent
 * non-empty value.
 */
export function pickKeyAnswers(callsNewestFirst: CallKeyAnswerSource[]): {
  decisionMakerReached: string | null;
  leadResponseTime: string | null;
} {
  const values = (key: string): string[] =>
    callsNewestFirst
      .map((c) => {
        const v = c.extractedData?.[key];
        return typeof v === "string" ? v.trim() : "";
      })
      .filter((v) => v.length > 0);
  const dm = values("decision_maker_reached");
  const decisionMakerReached =
    dm.find((v) => /^(yes|y|true|reached)\b/i.test(v)) ?? dm[0] ?? null;
  const lrt = values("lead_response_time");
  return { decisionMakerReached, leadResponseTime: lrt[0] ?? null };
}

function fmtInZone(iso: string, tz: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return d.toLocaleString("en-US", {
      ...opts,
      timeZone: tz || "America/New_York",
    });
  } catch {
    // Malformed/unknown timezone string from data → fall back to Eastern.
    return d.toLocaleString("en-US", { ...opts, timeZone: "America/New_York" });
  }
}

export type HandoffTaskInput = {
  company: string | null;
  ownerName: string | null;
  managerName: string | null;
  employeeName: string | null;
  businessPhone: string | null;
  businessEmail: string | null;
  timezone: string | null;
  appointmentAt: string | null;
};

/** The text of the Close Task the closer sees in their Inbox. Pure; reuses
 *  `fmtInZone` so the appointment time renders in the LEAD's timezone. Contact /
 *  appointment fragments are omitted when their data is absent. */
export function buildHandoffTaskText(input: HandoffTaskInput): string {
  const who =
    input.ownerName || input.managerName || input.employeeName || null;
  const when = input.appointmentAt
    ? `${fmtInZone(input.appointmentAt, input.timezone)} (${input.timezone || "America/New_York"})`
    : null;
  const contactBits = [who, input.businessPhone, input.businessEmail].filter(
    Boolean,
  );
  const parts: string[] = [
    `Run the booked demo with ${input.company ?? "this lead"}${when ? ` — ${when}` : ""}.`,
  ];
  if (contactBits.length) parts.push(`Contact: ${contactBits.join(" · ")}.`);
  parts.push("Full context is in the handoff note.");
  return parts.join(" ");
}

export function buildHandoffNote(input: HandoffNoteInput): string {
  const {
    lead,
    calls,
    leadResponseTime,
    decisionMakerReached,
    appointment,
    contextSummary,
    customFields,
  } = input;
  const lines: string[] = ["Handed off from Smile & Dial.", ""];

  const who = lead.ownerName
    ? `${lead.ownerName} (Owner)`
    : lead.managerName
      ? `${lead.managerName} (Manager)`
      : lead.employeeName
        ? `${lead.employeeName} (Contact)`
        : null;
  if (who) lines.push(`WHO TO MEET: ${who}`);

  const place = [lead.city, lead.state].filter(Boolean).join(", ");
  lines.push(`COMPANY: ${lead.company ?? "—"}${place ? ` · ${place}` : ""}`);

  const contactBits = [
    lead.businessPhone ? `PHONE: ${lead.businessPhone}` : null,
    lead.businessEmail ? `EMAIL: ${lead.businessEmail}` : null,
  ].filter(Boolean);
  if (contactBits.length) lines.push(contactBits.join("   "));

  if (appointment?.scheduledAt) {
    const tz = lead.timezone || "America/New_York";
    const when = fmtInZone(appointment.scheduledAt, lead.timezone);
    const link = appointment.eventLink
      ? `   [Calendly: ${appointment.eventLink}]`
      : "";
    lines.push("", `BOOKED APPOINTMENT: ${when} (${tz})${link}`);
  }

  // The rolling digest of what the lead said / is interested in — the context a
  // closer needs to pick up the deal. Sits above the raw per-call history.
  if (contextSummary && contextSummary.trim()) {
    lines.push("", "SUMMARY:", contextSummary.trim());
  }

  // CALL HISTORY — one entry per call (the caller passes them oldest→newest).
  const history = calls.filter((c) => c.summary || c.outcome);
  if (history.length) {
    lines.push(
      "",
      `CALL HISTORY (${history.length} call${history.length === 1 ? "" : "s"}):`,
    );
    for (const c of history) {
      const when = c.startedAt ? fmtInZone(c.startedAt, lead.timezone) : "—";
      const outcome = c.outcome ? c.outcome.replace(/_/g, " ") : "—";
      lines.push(`— ${when} · ${outcome}`);
      if (c.summary) lines.push(`  ${c.summary}`);
      if (c.recordingUrl) lines.push(`  Recording: ${c.recordingUrl}`);
    }
  }

  const answers: string[] = [];
  if (leadResponseTime)
    answers.push(`• Lead response time: ${leadResponseTime}`);
  if (decisionMakerReached)
    answers.push(`• Decision-maker reached: ${decisionMakerReached}`);
  for (const cf of customFields) answers.push(`• ${cf.label}: ${cf.value}`);
  if (answers.length) lines.push("", "KEY ANSWERS:", ...answers);

  return lines.join("\n");
}
