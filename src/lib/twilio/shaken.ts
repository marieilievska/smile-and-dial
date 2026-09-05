// SHAKEN/STIR A-attestation for the number pool: sign a number the moment it's
// bought, un-sign it the moment it's released.
//
// Both halves of the retired scripts/sync-shaken-numbers.mjs live here now, so
// the parent's Trust Hub mirrors the live subaccount pool on every buy and
// release without a local reconcile task in the loop.
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
