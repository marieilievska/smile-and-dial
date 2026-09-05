/**
 * Pure policy for human (browser) dials: who is really calling, whether they
 * may dial this lead, and which campaigns they may borrow a caller ID from.
 * No I/O so it is unit-testable; the voice-browser-dial route and
 * resolveHumanCallTarget apply it.
 */

const CLIENT_IDENTITY_RE =
  /^client:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The Supabase user id behind Twilio's `From=client:<identity>` parameter.
 *
 * The identity is the user id mintVoiceToken put in the access token, and it
 * is the only caller-related field Twilio itself vouches for: the browser can
 * send any leadId / userId it likes in the connect params, but it cannot forge
 * `From` — Twilio sets it from the token it validated. Returns null for
 * anything that isn't `client:` + a UUID (a PSTN From, a blank, garbage).
 */
export function parseClientIdentity(
  from: string | null | undefined,
): string | null {
  if (!from) return null;
  const match = CLIENT_IDENTITY_RE.exec(from.trim());
  return match ? match[1].toLowerCase() : null;
}

/** The caller's profile row, or null when no profile exists for the id. */
export type HumanDialCaller = { role: string; active: boolean } | null;

export type HumanDialRefusal =
  | "identity_mismatch"
  | "unknown_user"
  | "inactive_user"
  | "not_lead_owner";

export type HumanDialDecision =
  | { ok: true; isAdmin: boolean }
  | { ok: false; reason: HumanDialRefusal };

/**
 * May the proven caller dial this lead? Members may only dial leads they own;
 * active admins may dial any lead. `claimedUserId` is the userId the browser
 * sent alongside the dial — it must match the proven identity so a call row is
 * never attributed to someone else.
 */
export function authorizeHumanDial(input: {
  /** From Twilio's `From` (parseClientIdentity) — the identity we trust. */
  callerUserId: string;
  /** From the browser's connect params — must agree with callerUserId. */
  claimedUserId: string;
  caller: HumanDialCaller;
  leadOwnerId: string | null;
}): HumanDialDecision {
  if (input.claimedUserId !== input.callerUserId) {
    return { ok: false, reason: "identity_mismatch" };
  }
  if (!input.caller) return { ok: false, reason: "unknown_user" };
  if (!input.caller.active) return { ok: false, reason: "inactive_user" };
  const isAdmin = input.caller.role === "admin";
  if (!isAdmin && input.leadOwnerId !== input.callerUserId) {
    return { ok: false, reason: "not_lead_owner" };
  }
  return { ok: true, isAdmin };
}

/**
 * Which of a lead's attached campaigns this caller may borrow a caller ID
 * from, best first: the lead's owning campaign (when visible), then the rest in
 * the order given. Members only see their own campaigns; admins see them all.
 */
export function rankHumanCallCampaigns<
  T extends { id: string; owner_id: string },
>(
  campaigns: T[],
  scope: {
    userId: string;
    isAdmin: boolean;
    preferredCampaignId: string | null;
  },
): T[] {
  const visible = scope.isAdmin
    ? campaigns
    : campaigns.filter((c) => c.owner_id === scope.userId);
  const preferred = visible.filter((c) => c.id === scope.preferredCampaignId);
  const rest = visible.filter((c) => c.id !== scope.preferredCampaignId);
  return [...preferred, ...rest];
}
