// SHAKEN/STIR A-attestation for the number pool: sign a number the moment it's
// bought, un-sign it the moment it's released.
//
// Both halves of the retired scripts/sync-shaken-numbers.mjs live here now, so
// the parent's Trust Hub mirrors the live subaccount pool on every buy and
// release without a local reconcile task in the loop.
//
// Signing on purchase is best-effort by design — a Trust Hub hiccup must never
// cost us a number we just paid for — so `reconcileShakenNumbers` is the half
// that makes best-effort safe: every 30 minutes it re-diffs the whole pool
// against both containers and heals whatever a transient failure left behind.
// On 2026-09-02 the product POST failed for ten of 97 numbers and there was
// nothing to catch it, so they dialled for six days with no A-attestation.
//
// SHAKEN/STIR lives on the PARENT Twilio account (the app runs on a subaccount),
// so this authenticates with the parent creds and assigns the subaccount's PN
// sid to the parent's SHAKEN trust product + its supporting customer profile.
// Both the product AND its profile are DISCOVERED at call time — the product by
// its SHAKEN policy, the profile from the product's own EntityAssignments —
// rather than hardcoded: the setup was rebuilt once ("Voice Agents" on a new
// profile) and every hardcoded-profile assignment 400'd. The parent ACCOUNT sid
// (AC…) is push-protected on GitHub, so it stays in env. See the
// reference_twilio_trust_hub memory for how these resources were built.

import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

import { listOwnedNumberSids } from "./numbers";

const TRUSTHUB = "https://trusthub.twilio.com/v1";

/** Twilio's SHAKEN/STIR policy sid — stable; the trust product is found by it. */
export const SHAKEN_POLICY_SID = "RN7a97559effdf62d00f4298208492a5ea";

/** Upper bound on assignment pages walked per container, so a malformed
 *  next_page_url can never loop forever (200 × 50 = 10,000 numbers — far
 *  beyond the pool). */
const MAX_PAGES = 50;

export type ShakenResult = {
  ok: boolean;
  /** True when the step was skipped rather than attempted — the parent token
   *  isn't configured, or (un-signing only) Twilio isn't live — not a real
   *  failure. */
  skipped?: boolean;
  error: string | null;
};

/** One ChannelEndpointAssignment on a customer profile or trust product: the
 *  assignment's own sid (what a DELETE targets) and the number it points at. */
export type ChannelEndpointAssignment = {
  sid: string;
  channel_endpoint_sid?: string;
};

/** Parent-account Basic auth, or null when the token isn't configured (e.g. the
 *  parent creds haven't been added to this deployment's env yet). */
function parentAuth(): string | null {
  const sid = process.env.TWILIO_PARENT_ACCOUNT_SID;
  const token = process.env.TWILIO_PARENT_AUTH_TOKEN;
  if (!sid || !token) return null;
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

type TrustHubResponse = {
  ok: boolean;
  status: number;
  body: {
    message?: string;
    meta?: { next_page_url?: string | null };
    results?: {
      sid: string;
      policy_sid?: string;
      object_sid?: string;
      channel_endpoint_sid?: string;
    }[];
  };
};

/** `path` is either a Trust Hub path ("/TrustProducts…") or an absolute URL —
 *  Twilio's `meta.next_page_url` comes back absolute, so paging passes it
 *  straight through. */
async function trustHub(
  method: string,
  path: string,
  auth: string,
  params?: Record<string, string>,
): Promise<TrustHubResponse> {
  const headers: Record<string, string> = { Authorization: auth };
  const opts: RequestInit = { method, headers };
  if (params) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = new URLSearchParams(params);
  }
  const url = path.startsWith("http") ? path : `${TRUSTHUB}${path}`;
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body };
}

/** A POST that already exists (409 / "already") is a success — assignment is
 *  idempotent, so re-signing a number never errors. */
const assigned = (r: TrustHubResponse) =>
  r.ok || r.status === 409 || /already/i.test(r.body?.message ?? "");

// The SHAKEN trust product + its supporting customer profile are stable; resolve
// once and memoize so a batch buy doesn't re-list on every number. A rebuild is
// picked up on the next cold start.
let cached: { trustProductSid: string; profileSid: string } | null = null;

async function resolveShaken(
  auth: string,
): Promise<{ trustProductSid: string; profileSid: string } | null> {
  if (cached) return cached;
  const list = await trustHub("GET", "/TrustProducts?PageSize=200", auth);
  if (!list.ok) return null;
  const tp = (list.body.results ?? []).find(
    (p) => p.policy_sid === SHAKEN_POLICY_SID,
  );
  if (!tp) return null;
  // The product's supporting customer profile: a number must be on it before
  // the product will accept the assignment (else Twilio 400s).
  const ea = await trustHub(
    "GET",
    `/TrustProducts/${tp.sid}/EntityAssignments?PageSize=200`,
    auth,
  );
  const profileSid = (ea.body.results ?? [])[0]?.object_sid;
  if (!profileSid) return null;
  cached = { trustProductSid: tp.sid, profileSid };
  return cached;
}

/**
 * Give a just-purchased number A-attestation now: assign its (subaccount) PN sid
 * to the SHAKEN product's supporting customer profile FIRST, then the product
 * itself (Twilio's required order). Idempotent and best-effort — returns
 * { ok:false } rather than throwing, so a hiccup (or a not-yet-configured parent
 * token) never blocks a purchase.
 */
export async function assignNumberToShaken(
  twilioSid: string | null | undefined,
): Promise<ShakenResult> {
  if (!twilioSid) return { ok: false, error: "no Twilio number sid" };

  const auth = parentAuth();
  if (!auth) {
    return {
      ok: false,
      skipped: true,
      error: "parent Trust Hub token not configured",
    };
  }

  const resolved = await resolveShaken(auth);
  if (!resolved) {
    return {
      ok: false,
      error: "could not resolve the SHAKEN product/profile on the parent",
    };
  }

  const profile = await trustHub(
    "POST",
    `/CustomerProfiles/${resolved.profileSid}/ChannelEndpointAssignments`,
    auth,
    { ChannelEndpointType: "phone-number", ChannelEndpointSid: twilioSid },
  );
  if (!assigned(profile)) {
    return { ok: false, error: `profile assign failed (${profile.status})` };
  }

  const product = await trustHub(
    "POST",
    `/TrustProducts/${resolved.trustProductSid}/ChannelEndpointAssignments`,
    auth,
    { ChannelEndpointType: "phone-number", ChannelEndpointSid: twilioSid },
  );
  if (!assigned(product)) {
    return { ok: false, error: `product assign failed (${product.status})` };
  }

  return { ok: true, error: null };
}

/** The assignment sids on a container that point at `phoneNumberSid` — exactly
 *  what to DELETE to un-sign that number there. Pure (no I/O) so the matching
 *  is unit-tested without Twilio. */
export function assignmentSidsFor(
  assignments: ChannelEndpointAssignment[],
  phoneNumberSid: string,
): string[] {
  return assignments
    .filter((a) => a.channel_endpoint_sid === phoneNumberSid)
    .map((a) => a.sid);
}

/** Every ChannelEndpointAssignment on a container (customer profile or trust
 *  product), following `meta.next_page_url` so a pool larger than one page is
 *  still seen in full. Null when any page fails — un-signing must never guess
 *  from a partial list. */
async function listAssignments(
  auth: string,
  containerPath: string,
): Promise<ChannelEndpointAssignment[] | null> {
  const all: ChannelEndpointAssignment[] = [];
  let next: string | null =
    `${containerPath}/ChannelEndpointAssignments?PageSize=200`;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const r = await trustHub("GET", next, auth);
    if (!r.ok) return null;
    all.push(...(r.body.results ?? []));
    next = r.body.meta?.next_page_url ?? null;
  }
  return all;
}

/** DELETE each assignment on a container. A 404 means it's already gone —
 *  which is the goal — so only a real failure is returned (the first one). */
async function deleteAssignments(
  auth: string,
  containerPath: string,
  sids: string[],
): Promise<TrustHubResponse | null> {
  for (const sid of sids) {
    const r = await trustHub(
      "DELETE",
      `${containerPath}/ChannelEndpointAssignments/${sid}`,
      auth,
    );
    if (!r.ok && r.status !== 404) return r;
  }
  return null;
}

/**
 * Drop a released number's A-attestation: remove its (subaccount) PN sid from
 * the SHAKEN product FIRST, then from its supporting customer profile — the
 * reverse of assignNumberToShaken, since the product depends on the profile.
 * Lists both containers in full (paged) and deletes every matching assignment;
 * a number that was never signed is simply already done. Best-effort and never
 * throws: { ok:false } on a hiccup, `skipped` when the parent token isn't
 * configured or Twilio isn't live (a mock release never actually gave the
 * number up at Twilio, so it must stay signed).
 */
export async function unassignNumberFromShaken(
  twilioSid: string | null | undefined,
): Promise<ShakenResult> {
  if (!twilioSid) return { ok: false, error: "no Twilio number sid" };
  if (process.env.TWILIO_LIVE !== "live") {
    return { ok: false, skipped: true, error: "Twilio is not live" };
  }

  const auth = parentAuth();
  if (!auth) {
    return {
      ok: false,
      skipped: true,
      error: "parent Trust Hub token not configured",
    };
  }

  try {
    const resolved = await resolveShaken(auth);
    if (!resolved) {
      return {
        ok: false,
        error: "could not resolve the SHAKEN product/profile on the parent",
      };
    }
    const productPath = `/TrustProducts/${resolved.trustProductSid}`;
    const profilePath = `/CustomerProfiles/${resolved.profileSid}`;

    const onProduct = await listAssignments(auth, productPath);
    if (!onProduct) {
      return { ok: false, error: "could not list the product's assignments" };
    }
    const onProfile = await listAssignments(auth, profilePath);
    if (!onProfile) {
      return { ok: false, error: "could not list the profile's assignments" };
    }

    const productFail = await deleteAssignments(
      auth,
      productPath,
      assignmentSidsFor(onProduct, twilioSid),
    );
    if (productFail) {
      return {
        ok: false,
        error: `product unassign failed (${productFail.status})`,
      };
    }
    const profileFail = await deleteAssignments(
      auth,
      profilePath,
      assignmentSidsFor(onProfile, twilioSid),
    );
    if (profileFail) {
      return {
        ok: false,
        error: `profile unassign failed (${profileFail.status})`,
      };
    }

    return { ok: true, error: null };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "SHAKEN/STIR un-sign threw",
    };
  }
}

// ---------------------------------------------------------------------------
// Reconcile: make the parent's Trust Hub mirror the subaccount's live pool.
// ---------------------------------------------------------------------------

/** system_events kind for a reconcile pass that changed something. */
export const SHAKEN_RECONCILE_KIND = "shaken_reconcile";
/** system_events kind for a reconcile pass that failed or was aborted. */
export const SHAKEN_RECONCILE_FAILED_KIND = "shaken_reconcile_failed";
/** system_events kind for a purchase whose SHAKEN signing did not stick. */
export const SHAKEN_SIGN_FAILED_KIND = "shaken_sign_failed";

/** What one reconcile pass needs to do. Adds are PN sids (what you POST);
 *  removes are ASSIGNMENT sids — RA…, what a DELETE targets — because that is
 *  the only handle Twilio gives you on an assignment. */
export type ReconcilePlan = {
  addToProfile: string[];
  addToProduct: string[];
  removeFromProfile: string[];
  removeFromProduct: string[];
};

export type ShakenReconcileResult = {
  ok: boolean;
  /** True when nothing was attempted (Twilio isn't live, parent token absent)
   *  rather than attempted and failed. */
  skipped?: boolean;
  error?: string | null;
  /** Assignments successfully created (profile + product each count one). */
  added?: number;
  /** Assignments successfully deleted. */
  removed?: number;
};

/** The diff for ONE container: which live numbers it is missing, and which of
 *  its assignments should not be there — anything pointing at a number the
 *  account no longer owns, plus every duplicate past the first for a number it
 *  does (Twilio permits two assignments for one number; keeping the first means
 *  the number stays signed while the extras come off). */
function diffContainer(
  live: readonly string[],
  assignments: readonly ChannelEndpointAssignment[],
): { add: string[]; remove: string[] } {
  const liveSet = new Set(live);
  const seen = new Set<string>();
  const remove: string[] = [];
  for (const a of assignments) {
    const pn = a.channel_endpoint_sid;
    if (!pn || !liveSet.has(pn) || seen.has(pn)) {
      remove.push(a.sid);
      continue;
    }
    seen.add(pn);
  }
  return { add: live.filter((pn) => !seen.has(pn)), remove };
}

/**
 * Diff the live subaccount pool against what the parent's Trust Hub holds.
 *
 * Pure, so the shapes that matter can be tested without Twilio — including the
 * one that caused this: a number assigned to the supporting customer profile
 * but NOT to the trust product, which dials with no A-attestation and looks
 * fine everywhere except on the callee's handset.
 *
 * Both inputs are ChannelEndpointAssignments (phone numbers), never
 * EntityAssignments (business profiles and supporting documents) — the two are
 * trivially confused, and only the former has anything to do with a number.
 */
export function planShakenReconcile(
  livePhoneSids: readonly string[],
  onProfile: readonly ChannelEndpointAssignment[],
  onProduct: readonly ChannelEndpointAssignment[],
): ReconcilePlan {
  const profile = diffContainer(livePhoneSids, onProfile);
  const product = diffContainer(livePhoneSids, onProduct);
  return {
    addToProfile: profile.add,
    addToProduct: product.add,
    removeFromProfile: profile.remove,
    removeFromProduct: product.remove,
  };
}

/** Plan sizes for the audit payload — the counts, not 184 sids. */
function planSizes(plan: ReconcilePlan): Record<string, number> {
  return {
    add_to_profile: plan.addToProfile.length,
    add_to_product: plan.addToProduct.length,
    remove_from_profile: plan.removeFromProfile.length,
    remove_from_product: plan.removeFromProduct.length,
  };
}

/** Index assignments by their own sid, so a failed delete can be traced back
 *  to the number it belongs to. */
function phoneByAssignmentSid(
  assignments: readonly ChannelEndpointAssignment[],
): Map<string, string | undefined> {
  return new Map(assignments.map((a) => [a.sid, a.channel_endpoint_sid]));
}

/** Write one row to the system_events audit log. Best-effort and never throws:
 *  this is bookkeeping ABOUT a failure, so it must not become a second one. A
 *  console.warn in a serverless function is half of why the original ten
 *  numbers stayed broken for six days; system_events is read. */
async function logShakenEvent(
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await createAdminClient()
      .from("system_events")
      .insert({
        kind,
        actor_user_id: null,
        ref_table: "twilio_numbers",
        ref_id: null,
        payload: payload as Json,
      });
  } catch {
    /* best-effort */
  }
}

/**
 * Make the parent's SHAKEN trust product and its supporting customer profile
 * hold exactly the numbers the subaccount owns: sign anything missing, un-sign
 * anything dead. The backstop for `assignNumberToShaken`, which is best-effort
 * per purchase and whose caller cannot retry it.
 *
 * Ordering is Twilio's, not ours. Adds go profile FIRST, then product: the
 * product 400s ("not assigned to all the required supporting Customer profile")
 * for a number the profile does not already carry. Removes go the other way,
 * product first, since the product depends on the profile. A number whose
 * profile add fails is skipped on the product half of the same pass, and a
 * number whose product delete fails keeps its profile assignment — the next
 * pass retries both, which is the whole point of running on a schedule.
 *
 * THE SAFETY GUARD, and why it is not the old one. The retired
 * scripts/sync-shaken-numbers.mjs aborted whenever the subaccount returned ZERO
 * numbers, on the theory that a wholesale un-signing must be a bad read. That
 * guard was both too weak and too strong: a failed read does not have to come
 * back empty (a truncated page comes back short), and a genuinely empty account
 * is a state the pool reaches every time it is released — where the guard
 * blocked the exact cleanup it was written for, leaving 184 orphaned
 * assignments pointing at dead numbers. What matters is whether we READ Twilio,
 * not what the read said:
 *
 *   - the number list errors on any page      -> abort, change nothing;
 *   - the number list succeeds and is empty   -> a true zero, remove the lot;
 *   - listAssignments returns null (a page failed) -> abort, change nothing.
 *
 * Mock mode counts as a failed read, not an empty account: `listOwnedNumberSids`
 * errors rather than returning [] unless TWILIO_LIVE is live, so a preview
 * deployment can never strip the parent's Trust Hub.
 */
export async function reconcileShakenNumbers(): Promise<ShakenReconcileResult> {
  if (process.env.TWILIO_LIVE !== "live") {
    return { ok: false, skipped: true, error: "Twilio is not live" };
  }
  const auth = parentAuth();
  if (!auth) {
    return {
      ok: false,
      skipped: true,
      error: "parent Trust Hub token not configured",
    };
  }

  let added = 0;
  let removed = 0;
  let firstError: string | null = null;
  const fail = (message: string) => {
    firstError ??= message;
  };

  /** Return the result, logging it when it changed something or went wrong. A
   *  clean no-op pass writes nothing: it runs 48 times a day, and an audit
   *  trail of "nothing happened" is one nobody reads. */
  const report = async (
    result: ShakenReconcileResult,
    extra: Record<string, unknown> = {},
  ): Promise<ShakenReconcileResult> => {
    const changed = (result.added ?? 0) > 0 || (result.removed ?? 0) > 0;
    if (!result.ok || changed) {
      await logShakenEvent(
        result.ok ? SHAKEN_RECONCILE_KIND : SHAKEN_RECONCILE_FAILED_KIND,
        {
          added: result.added ?? 0,
          removed: result.removed ?? 0,
          error: result.error ?? null,
          ...extra,
        },
      );
    }
    return result;
  };

  try {
    const resolved = await resolveShaken(auth);
    if (!resolved) {
      return report({
        ok: false,
        error: "could not resolve the SHAKEN product/profile on the parent",
      });
    }
    const productPath = `/TrustProducts/${resolved.trustProductSid}`;
    const profilePath = `/CustomerProfiles/${resolved.profileSid}`;

    // Read everything BEFORE changing anything, and abort on any read failure.
    //
    // Assignments FIRST, live numbers SECOND, and the order is load-bearing: a
    // number bought while this runs must never be un-signed. Read this way, a
    // purchase landing mid-pass is in the number list but not in the assignment
    // list, so the plan can only try to ADD it — an idempotent POST Twilio
    // answers "already". The other order loses that: the number would be
    // missing from the list while its brand-new assignments were already in
    // hand, and the pass would strip the signing off a live number and leave it
    // that way until the next run. (It nearly happened on the first live run of
    // this code — two numbers were bought 15 seconds before it finished.)
    const onProfile = await listAssignments(auth, profilePath);
    if (!onProfile) {
      return report({
        ok: false,
        error: "could not list the profile's assignments",
      });
    }
    const onProduct = await listAssignments(auth, productPath);
    if (!onProduct) {
      return report({
        ok: false,
        error: "could not list the product's assignments",
      });
    }

    const live = await listOwnedNumberSids();
    if (live.error) return report({ ok: false, error: live.error });

    const plan = planShakenReconcile(live.sids, onProfile, onProduct);

    // --- add: profile FIRST, then product ---------------------------------
    const profileAddFailed = new Set<string>();
    for (const pn of plan.addToProfile) {
      const r = await trustHub(
        "POST",
        `${profilePath}/ChannelEndpointAssignments`,
        auth,
        { ChannelEndpointType: "phone-number", ChannelEndpointSid: pn },
      );
      if (assigned(r)) {
        added++;
      } else {
        profileAddFailed.add(pn);
        fail(`profile assign failed for ${pn} (${r.status})`);
      }
    }
    for (const pn of plan.addToProduct) {
      // The product rejects a number the profile does not carry, so one whose
      // profile assignment just failed waits for the next pass.
      if (profileAddFailed.has(pn)) continue;
      const r = await trustHub(
        "POST",
        `${productPath}/ChannelEndpointAssignments`,
        auth,
        { ChannelEndpointType: "phone-number", ChannelEndpointSid: pn },
      );
      if (assigned(r)) added++;
      else fail(`product assign failed for ${pn} (${r.status})`);
    }

    // --- remove: product FIRST, then profile ------------------------------
    const productPhones = phoneByAssignmentSid(onProduct);
    const profilePhones = phoneByAssignmentSid(onProfile);
    const stillOnProduct = new Set<string>();
    for (const sid of plan.removeFromProduct) {
      const r = await trustHub(
        "DELETE",
        `${productPath}/ChannelEndpointAssignments/${sid}`,
        auth,
      );
      // A 404 means it is already gone, which is the goal.
      if (r.ok || r.status === 404) {
        removed++;
      } else {
        const pn = productPhones.get(sid);
        if (pn) stillOnProduct.add(pn);
        fail(`product unassign failed for ${sid} (${r.status})`);
      }
    }
    for (const sid of plan.removeFromProfile) {
      const pn = profilePhones.get(sid);
      // Leave the profile assignment for a number the product still carries.
      if (pn && stillOnProduct.has(pn)) continue;
      const r = await trustHub(
        "DELETE",
        `${profilePath}/ChannelEndpointAssignments/${sid}`,
        auth,
      );
      if (r.ok || r.status === 404) removed++;
      else fail(`profile unassign failed for ${sid} (${r.status})`);
    }

    return report(
      { ok: firstError === null, error: firstError, added, removed },
      { live_numbers: live.sids.length, plan: planSizes(plan) },
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : "SHAKEN reconcile threw";
    return report({ ok: false, error, added, removed });
  }
}

/**
 * Record that a purchase's SHAKEN signing did not stick. Best-effort — a Trust
 * Hub hiccup must never fail a purchase, and the reconcile is what heals it —
 * but it goes somewhere a person can see, which a console.warn in a serverless
 * function is not.
 */
export async function logShakenSignFailure(
  phoneNumber: string,
  twilioSid: string | null,
  error: string | null,
): Promise<void> {
  await logShakenEvent(SHAKEN_SIGN_FAILED_KIND, {
    phone_number: phoneNumber,
    twilio_sid: twilioSid,
    error,
  });
}
