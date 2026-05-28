/** Build the best-effort drill-down URL for an event's referenced
 *  object. Some tables have first-class detail routes (leads), some
 *  only support filtering on the list page (campaigns, calls), and
 *  some have no detail surface at all (dnc_removals, system_events).
 *
 *  Returns `null` when there's nowhere useful to drill. */
export function refHrefFor(
  table: string | null | undefined,
  id: string | null | undefined,
): string | null {
  if (!table || !id) return null;
  switch (table) {
    case "leads":
      return `/leads/${id}`;
    case "calls":
      return `/calls?call=${id}`;
    case "campaigns":
      return `/campaigns?status=all`;
    case "callbacks":
      return `/callbacks`;
    case "dnc_entries":
    case "dnc_removals":
      return `/dnc`;
    case "twilio_numbers":
      return `/settings/twilio-numbers`;
    case "agents":
      return `/settings/agents`;
    case "lists":
      return `/leads?list=${id}`;
    case "goals":
      return `/settings/goals`;
    case "knowledge_bases":
      return `/settings/knowledge-bases`;
    default:
      return null;
  }
}

/** Short human label for the ref-table prefix. We strip plurals and
 *  swap underscores for spaces so "twilio_numbers" reads as
 *  "Twilio number" inside the cell. */
const TABLE_LABELS: Record<string, string> = {
  leads: "Lead",
  calls: "Call",
  campaigns: "Campaign",
  callbacks: "Callback",
  dnc_entries: "DNC entry",
  dnc_removals: "DNC removal",
  twilio_numbers: "Twilio number",
  agents: "Agent",
  lists: "List",
  goals: "Goal",
  knowledge_bases: "Knowledge base",
};

export function refLabelFor(table: string | null | undefined): string {
  if (!table) return "—";
  return TABLE_LABELS[table] ?? table.replace(/_/g, " ");
}
