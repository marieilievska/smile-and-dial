// Instant SHAKEN/STIR A-attestation for a freshly-purchased number.
//
// Ports the "add one number" path of scripts/sync-shaken-numbers.mjs into the
// app so a number is signed the moment it's bought, instead of waiting up to
// 30 min for the local reconcile task. That task stays as the backstop (and
// still handles REMOVING released numbers, which this does not).
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

// Twilio's SHAKEN/STIR policy sid — stable; the trust product is found by it.
const SHAKEN_POLICY_SID = "RN7a97559effdf62d00f4298208492a5ea";

export type ShakenResult = {
  ok: boolean;
  /** True when signing was skipped because the parent token isn't configured
   *  (the local reconcile task remains the backstop) — not a real failure. */
  skipped?: boolean;
  error: string | null;
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
    results?: { sid: string; policy_sid?: string; object_sid?: string }[];
  };
};

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
  const r = await fetch(`${TRUSTHUB}${path}`, opts);
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
 * token) never blocks a purchase; the 30-min reconcile task backstops any miss.
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
