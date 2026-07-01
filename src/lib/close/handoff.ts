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
  call: {
    summary: string | null;
    disposition: string | null;
    leadResponseTime: string | null;
    decisionMakerReached: string | null;
    startedAt: string | null;
    recordingUrl: string | null;
  } | null;
  appointment: { scheduledAt: string | null; eventLink: string | null } | null;
  customFields: { label: string; value: string }[];
};

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
  const { lead, call, appointment, customFields } = input;
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

  if (call?.summary) {
    const on = call.startedAt
      ? ` (${fmtInZone(call.startedAt, lead.timezone)})`
      : "";
    lines.push("", `AI CALL SUMMARY${on}:`, call.summary);
  }

  const answers: string[] = [];
  if (call?.leadResponseTime)
    answers.push(`• Lead response time: ${call.leadResponseTime}`);
  if (call?.decisionMakerReached)
    answers.push(`• Decision-maker reached: ${call.decisionMakerReached}`);
  for (const cf of customFields) answers.push(`• ${cf.label}: ${cf.value}`);
  if (answers.length) lines.push("", "KEY ANSWERS:", ...answers);

  if (call?.recordingUrl) lines.push("", `RECORDING: ${call.recordingUrl}`);

  return lines.join("\n");
}
