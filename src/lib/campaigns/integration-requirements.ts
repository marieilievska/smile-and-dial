import type { ToolsEnabled } from "@/lib/agents/prompt";

/** Which PER-USER integrations a campaign needs before it may go live. Every
 *  user connects their own Calendly and Close (user_integrations); a campaign's
 *  calls use the CAMPAIGN OWNER's connections. Not every campaign books or
 *  messages, so nothing is required unless the setup actually uses it:
 *  - Calendly: the agent has a booking tool enabled, or the campaign itself is
 *    configured to book (an event chosen, or fixed-time booking on).
 *  - Close: the agent can send an email or a text.
 *  Pure — unit-tested without the database. */
export type IntegrationRequirements = {
  needsCalendly: boolean;
  needsClose: boolean;
};

export function campaignIntegrationRequirements(input: {
  agentToolsEnabled: ToolsEnabled | null | undefined;
  calendlyEventId: string | null | undefined;
  fixedTimeBooking: boolean | null | undefined;
}): IntegrationRequirements {
  const tools = input.agentToolsEnabled ?? {};
  const needsCalendly =
    tools.get_available_times === true ||
    tools.book_appointment === true ||
    Boolean(input.calendlyEventId?.trim()) ||
    input.fixedTimeBooking === true;
  const needsClose = tools.send_email === true || tools.send_text === true;
  return { needsCalendly, needsClose };
}

export type MissingIntegrations = { calendly: boolean; close: boolean };

/** Requirements minus what the owner has connected. */
export function missingIntegrations(
  requirements: IntegrationRequirements,
  connected: { calendly: boolean; close: boolean },
): MissingIntegrations {
  return {
    calendly: requirements.needsCalendly && !connected.calendly,
    close: requirements.needsClose && !connected.close,
  };
}

/** The launch-blocking message, or null when nothing is missing. Names every
 *  missing integration and WHY it's needed, and points at the one place to fix
 *  it. `ownerIsActor` false = an admin is launching someone else's campaign, so
 *  the OWNER (whose Calendly/Close the calls use) is the one who must connect —
 *  the admin connecting their own wouldn't help. */
export function missingIntegrationsMessage(
  missing: MissingIntegrations,
  opts: { ownerIsActor?: boolean } = {},
): string | null {
  const names: string[] = [];
  const reasons: string[] = [];
  if (missing.calendly) {
    names.push("Calendly");
    reasons.push("books appointments");
  }
  if (missing.close) {
    names.push("Close");
    reasons.push("sends emails or texts");
  }
  if (names.length === 0) return null;
  const lead =
    opts.ownerIsActor === false
      ? "The campaign owner needs to connect"
      : "Connect";
  return `${lead} ${names.join(" and ")} in Settings → Integrations before launching — this campaign's agent ${reasons.join(" and ")}.`;
}
