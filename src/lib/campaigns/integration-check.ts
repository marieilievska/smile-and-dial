import "server-only";

import type { ToolsEnabled } from "@/lib/agents/prompt";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  campaignIntegrationRequirements,
  missingIntegrations,
  missingIntegrationsMessage,
  type IntegrationRequirements,
} from "./integration-requirements";

/**
 * Check the campaign OWNER's connections against what the campaign needs, and
 * return the launch-blocking message (null = clear to go live).
 *
 * Reads user_integrations with the service client, scoped to the one owner: an
 * admin launching a member's campaign is checked against the MEMBER, because
 * the member's Calendly/Close are what the calls will actually use (the tool
 * webhook resolves them from campaigns.owner_id). Fails closed on a read error
 * — but says so, rather than pretending an integration is missing.
 */
export async function assertOwnerIntegrations(
  ownerId: string,
  requirements: IntegrationRequirements,
  opts: { actorUserId?: string | null } = {},
): Promise<string | null> {
  if (!requirements.needsCalendly && !requirements.needsClose) return null;

  const admin = createAdminClient();
  const { data: integ, error } = await admin
    .from("user_integrations")
    .select("calendly_api_key, close_api_key")
    .eq("user_id", ownerId)
    .maybeSingle();
  if (error) {
    return "Couldn't verify the campaign's integrations just now — try again in a moment.";
  }

  const missing = missingIntegrations(requirements, {
    calendly: Boolean(integ?.calendly_api_key?.trim()),
    close: Boolean(integ?.close_api_key?.trim()),
  });
  return missingIntegrationsMessage(missing, {
    ownerIsActor: opts.actorUserId == null || opts.actorUserId === ownerId,
  });
}

/**
 * Everything launch / resume / activate-on-create needs in one call: read the
 * agent's enabled tools, derive the requirements, check the owner. Null = go.
 * Draft saving and editing never call this — only the moment a campaign goes
 * (back) into service.
 */
export async function campaignLaunchBlocker(input: {
  ownerId: string;
  actorUserId?: string | null;
  agentId: string | null | undefined;
  calendlyEventId: string | null | undefined;
  fixedTimeBooking: boolean | null | undefined;
}): Promise<string | null> {
  let tools: ToolsEnabled | null = null;
  if (input.agentId) {
    // Service client: a member's agent may sit outside the launcher's RLS view,
    // and an unreadable agent must not silently count as "no tools" (that would
    // let a booking campaign launch unchecked).
    const admin = createAdminClient();
    const { data: agent } = await admin
      .from("agents")
      .select("tools_enabled")
      .eq("id", input.agentId)
      .maybeSingle();
    tools = (agent?.tools_enabled ?? null) as unknown as ToolsEnabled | null;
  }
  return assertOwnerIntegrations(
    input.ownerId,
    campaignIntegrationRequirements({
      agentToolsEnabled: tools,
      calendlyEventId: input.calendlyEventId,
      fixedTimeBooking: input.fixedTimeBooking,
    }),
    { actorUserId: input.actorUserId },
  );
}
