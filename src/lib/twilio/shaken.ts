// Instant SHAKEN/STIR A-attestation for a freshly-purchased number.
//
// Ports the "add one number" path of scripts/sync-shaken-numbers.mjs into the
// app so a number is signed the moment it's bought, instead of waiting up to
// 30 min for the local reconcile task. That task stays as the backstop (and
// still handles REMOVING released numbers, which this does not).
//
// SHAKEN/STIR lives on the PARENT Twilio account (the app runs on a subaccount).
// So this authenticates with the parent creds and assigns the subaccount's PN
// sid to the parent's customer profile + SHAKEN trust product. The parent
// ACCOUNT sid (AC…) is push-protected on GitHub, so it stays in env; only the
// BU/RN resource sids (safe to commit) are hardcoded. See
// reference_twilio_trust_hub memory for how these were built.

const TRUSTHUB = "https://trusthub.twilio.com/v1";

// Approved Trust Hub resources on the PARENT account.
const SECONDARY_PROFILE_SID = "BU3cbdfe1e1bb900f7680023ab439428ec"; // "Smile and Dial" customer profile
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
  body: { message?: string; results?: { sid: string; policy_sid: string }[] };
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

// The SHAKEN/STIR trust product sid is stable; discover it once and memoize so a
// batch buy doesn't re-list on every number. A rebuild is picked up on the next
// cold start.
let cachedTrustProductSid: string | null = null;

async function resolveShakenTrustProduct(auth: string): Promise<string | null> {
  if (cachedTrustProductSid) return cachedTrustProductSid;
  const list = await trustHub("GET", "/TrustProducts?PageSize=200", auth);
  if (!list.ok) return null;
  const tp = (list.body.results ?? []).find(
    (p) => p.policy_sid === SHAKEN_POLICY_SID,
  );
  cachedTrustProductSid = tp?.sid ?? null;
  return cachedTrustProductSid;
}

/**
 * Give a just-purchased number A-attestation now: assign its (subaccount) PN sid
 * to the customer profile FIRST, then the SHAKEN/STIR trust product (Twilio
 * requires the supporting profile to carry the number before the product will
 * accept it). Idempotent and best-effort — returns { ok:false } rather than
 * throwing, so a hiccup (or a not-yet-configured parent token) never blocks a
 * purchase; the 30-min reconcile task backstops any miss.
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

  const trustProductSid = await resolveShakenTrustProduct(auth);
  if (!trustProductSid) {
    return { ok: false, error: "no SHAKEN/STIR trust product on the parent" };
  }

  const profile = await trustHub(
    "POST",
    `/CustomerProfiles/${SECONDARY_PROFILE_SID}/ChannelEndpointAssignments`,
    auth,
    { ChannelEndpointType: "phone-number", ChannelEndpointSid: twilioSid },
  );
  if (!assigned(profile)) {
    return { ok: false, error: `profile assign failed (${profile.status})` };
  }

  const product = await trustHub(
    "POST",
    `/TrustProducts/${trustProductSid}/ChannelEndpointAssignments`,
    auth,
    { ChannelEndpointType: "phone-number", ChannelEndpointSid: twilioSid },
  );
  if (!assigned(product)) {
    return { ok: false, error: `product assign failed (${product.status})` };
  }

  return { ok: true, error: null };
}
