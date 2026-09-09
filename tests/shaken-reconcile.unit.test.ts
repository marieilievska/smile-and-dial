import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assignNumberToShaken,
  isUnsignableCountry,
  planShakenReconcile,
  reconcileShakenNumbers,
  SHAKEN_POLICY_SID,
  type ChannelEndpointAssignment,
  type ReconcilePlan,
} from "@/lib/twilio/shaken";

/**
 * The diff behind the SHAKEN/STIR reconcile: what the parent's Trust Hub holds
 * versus what the subaccount actually owns.
 *
 * Pure — no Twilio, no network — because the half-assigned state this heals is
 * unreachable from a test that has to go through the API. On 2026-09-02, ten of
 * 97 freshly bought numbers landed on the supporting customer profile and not
 * on the trust product, and dialled for six days without A-attestation. Every
 * shape that produced, and every shape a reconcile could get wrong, is below.
 *
 * The two Twilio resources are easy to confuse and this whole bug turns on the
 * difference: EntityAssignments hold business profiles and documents,
 * ChannelEndpointAssignments hold PHONE NUMBERS. This plans over the latter.
 */

const PN = (n: number) => `PN${String(n).padStart(4, "0")}`;
const on = (
  assignmentSid: string,
  phone: string,
): ChannelEndpointAssignment => ({
  sid: assignmentSid,
  channel_endpoint_sid: phone,
});

const EMPTY: ReconcilePlan = {
  addToProfile: [],
  addToProduct: [],
  removeFromProfile: [],
  removeFromProduct: [],
};

describe("planShakenReconcile", () => {
  it("signs a number that is on neither container", () => {
    const plan = planShakenReconcile([PN(1)], [], []);
    expect(plan).toEqual({
      ...EMPTY,
      addToProfile: [PN(1)],
      addToProduct: [PN(1)],
    });
  });

  it("re-adds ONLY the product for the 2026-09-02 ten: on the profile, missing from the product", () => {
    // The exact production defect. assignNumberToShaken POSTs the profile
    // first and the product second; the second POST failed transiently for ten
    // of 97 numbers, leaving them assigned to the supporting profile and not to
    // the SHAKEN trust product — dialling without A-attestation, and nothing
    // retried. The plan must ask for the product assignment and nothing else:
    // re-POSTing the profile is harmless, but removing anything here would be
    // the reconcile un-signing the pool it exists to protect.
    const live = [PN(1), PN(2), PN(3)];
    const onProfile = [on("RAf1", PN(1)), on("RAf2", PN(2)), on("RAf3", PN(3))];
    const onProduct = [on("RAp1", PN(1)), on("RAp3", PN(3))];

    expect(planShakenReconcile(live, onProfile, onProduct)).toEqual({
      ...EMPTY,
      addToProduct: [PN(2)],
    });
  });

  it("does nothing for a number already on both", () => {
    const plan = planShakenReconcile(
      [PN(1)],
      [on("RAf1", PN(1))],
      [on("RAp1", PN(1))],
    );
    expect(plan).toEqual(EMPTY);
  });

  it("removes a released number from both, by ASSIGNMENT sid", () => {
    // What comes back is the RA… sid a DELETE targets, never the PN… sid.
    const plan = planShakenReconcile(
      [PN(1)],
      [on("RAf1", PN(1)), on("RAf9", PN(9))],
      [on("RAp1", PN(1)), on("RAp9", PN(9))],
    );
    expect(plan).toEqual({
      ...EMPTY,
      removeFromProfile: ["RAf9"],
      removeFromProduct: ["RAp9"],
    });
    expect(plan.removeFromProfile.every((s) => s.startsWith("RA"))).toBe(true);
  });

  it("removes everything when the account genuinely owns no numbers", () => {
    // Today's orphan cleanup: 97 assignments on the profile and 87 on the
    // product, every one pointing at a released, dead PN sid. The old script
    // aborted on a zero count and would have left all 184 in place forever.
    const onProfile = Array.from({ length: 97 }, (_, i) =>
      on(`RAf${i}`, PN(i)),
    );
    const onProduct = Array.from({ length: 87 }, (_, i) =>
      on(`RAp${i}`, PN(i)),
    );
    const plan = planShakenReconcile([], onProfile, onProduct);

    expect(plan.addToProfile).toEqual([]);
    expect(plan.addToProduct).toEqual([]);
    expect(plan.removeFromProfile).toHaveLength(97);
    expect(plan.removeFromProduct).toHaveLength(87);
    expect(plan.removeFromProfile.length + plan.removeFromProduct.length).toBe(
      184,
    );
  });

  it("plans nothing when the Trust Hub already mirrors the pool", () => {
    const live = [PN(1), PN(2), PN(3)];
    const onProfile = live.map((p, i) => on(`RAf${i}`, p));
    const onProduct = live.map((p, i) => on(`RAp${i}`, p));
    expect(planShakenReconcile(live, onProfile, onProduct)).toEqual(EMPTY);
  });

  it("keeps one duplicate assignment per number and removes the rest", () => {
    // Twilio permits two assignments for the same number on one container.
    // The first is kept — the number stays signed throughout — and the extras
    // come off, so a duplicate can never be read as a missing assignment.
    const plan = planShakenReconcile(
      [PN(1)],
      [on("RAf1", PN(1)), on("RAf2", PN(1)), on("RAf3", PN(1))],
      [on("RAp1", PN(1)), on("RAp2", PN(1))],
    );
    expect(plan).toEqual({
      ...EMPTY,
      removeFromProfile: ["RAf2", "RAf3"],
      removeFromProduct: ["RAp2"],
    });
  });

  it("removes an assignment that points at no number at all", () => {
    // channel_endpoint_sid is optional on the wire; an assignment without one
    // matches no live number and cannot be reasoned about, so it goes.
    const plan = planShakenReconcile([PN(1)], [{ sid: "RAf0" }], []);
    expect(plan.removeFromProfile).toEqual(["RAf0"]);
    expect(plan.addToProfile).toEqual([PN(1)]);
  });

  it("is a no-op on an empty account with an empty Trust Hub", () => {
    expect(planShakenReconcile([], [], [])).toEqual(EMPTY);
  });

  it("does not mutate what it is given", () => {
    const live = [PN(1)];
    const onProfile = [on("RAf9", PN(9))];
    const onProduct: ChannelEndpointAssignment[] = [];
    planShakenReconcile(live, onProfile, onProduct);
    expect(live).toEqual([PN(1)]);
    expect(onProfile).toEqual([on("RAf9", PN(9))]);
    expect(onProduct).toEqual([]);
  });
});

/**
 * The schedule itself. Guarded here, in the file the feature lives in, because
 * the predecessor's schedule was a Windows Task Scheduler entry: nothing in the
 * repo referenced it, so nobody could tell it had stopped running, and the
 * script it drove was later deleted as dead code. A pg_cron schedule is text in
 * a migration, so it can be asserted — and `evaluate_alerts()` raises
 * `cron_missed` when it stops firing.
 */
describe("the shaken-reconcile cron", () => {
  const MIGRATION =
    "supabase/migrations/20260908120000_shaken_reconcile_cron.sql";
  const CANONICAL_HOST = "https://www.smile-and-dial.com";
  const ROUTE_PATH = "/api/shaken/reconcile";

  const raw = readFileSync(
    fileURLToPath(new URL(`../${MIGRATION}`, import.meta.url)),
    "utf8",
  );
  /** Comments stripped, so assertions see what runs and not the prose. */
  const sql = raw.replace(/--[^\n]*/g, "");

  it("is scheduled every 30 minutes", () => {
    expect(sql).toMatch(
      /cron\.schedule\(\s*'shaken-reconcile',\s*'\*\/30 \* \* \* \*'/,
    );
  });

  it("POSTs the canonical host, not a Vercel alias", () => {
    expect(sql).toContain(`url := '${CANONICAL_HOST}${ROUTE_PATH}'`);
    expect(sql).not.toContain("vercel.app");
  });

  it("passes the dialer secret from app_settings", () => {
    expect(sql).toContain("'x-dialer-secret'");
    expect(sql).toContain(
      "(select dialer_tick_secret from public.app_settings limit 1), ''",
    );
  });

  it("unschedules by name first, so re-running the migration is safe", () => {
    expect(sql).toMatch(
      /select cron\.unschedule\(jobid\)\s+from cron\.job\s+where jobname = 'shaken-reconcile';/,
    );
  });

  it("points at a route that exists and answers POST", () => {
    // A typo in the URL would schedule a 404 every 30 minutes, for ever, and
    // look exactly like a working cron from inside Postgres.
    const route = fileURLToPath(
      new URL(`../src/app${ROUTE_PATH}/route.ts`, import.meta.url),
    );
    expect(existsSync(route)).toBe(true);
    expect(readFileSync(route, "utf8")).toContain("export async function POST");
  });
});

/**
 * The reconcile itself, against a stubbed Trust Hub and a stubbed Twilio
 * number list. No network.
 *
 * These cover the three things the planner cannot: the ORDER of the reads, the
 * order of the writes, and the guard that decides whether to write at all.
 */
describe("reconcileShakenNumbers", () => {
  const TRUSTHUB = "https://trusthub.twilio.com/v1";
  const PRODUCT = "BUproduct";
  const PROFILE = "BUprofile";
  const SUBACCOUNT = "ACsubaccount";
  const PRODUCT_CEA = `${TRUSTHUB}/TrustProducts/${PRODUCT}/ChannelEndpointAssignments`;
  const PROFILE_CEA = `${TRUSTHUB}/CustomerProfiles/${PROFILE}/ChannelEndpointAssignments`;
  const NUMBERS = `https://api.twilio.com/2010-04-01/Accounts/${SUBACCOUNT}/IncomingPhoneNumbers.json`;

  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env.TWILIO_LIVE = "live";
    process.env.TWILIO_PARENT_ACCOUNT_SID = "ACparent";
    process.env.TWILIO_PARENT_AUTH_TOKEN = "parent-token";
    process.env.TWILIO_ACCOUNT_SID = SUBACCOUNT;
    process.env.TWILIO_API_KEY_SID = "SKtest";
    process.env.TWILIO_API_KEY_SECRET = "sk-secret";
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllGlobals();
  });

  type Call = { method: string; url: string; body: string | null };

  /** Plays the parent Trust Hub and the subaccount's number list. */
  function stub(opts: {
    live?: string[];
    /** E.164 per live sid. Omitted sids come back with no `phone_number`,
     *  which is what Twilio does for a malformed row and what every test
     *  written before the country guard assumes. */
    livePhones?: Record<string, string>;
    /** Non-200 status for the IncomingPhoneNumbers GET. */
    numbersStatus?: number;
    onProfile?: ChannelEndpointAssignment[];
    onProduct?: ChannelEndpointAssignment[];
    writeStatus?: (method: string, url: string) => number;
  }): { calls: Call[] } {
    const calls: Call[] = [];
    const json = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? String(init.body) : null;
        calls.push({ method, url, body });

        if (method === "POST" || method === "DELETE") {
          if (url.startsWith(NUMBERS)) return json(200, {});
          return json((opts.writeStatus ?? (() => 201))(method, url), {});
        }
        if (url.startsWith(NUMBERS)) {
          if (opts.numbersStatus && opts.numbersStatus !== 200) {
            return json(opts.numbersStatus, {});
          }
          return json(200, {
            incoming_phone_numbers: (opts.live ?? []).map((sid) => ({
              sid,
              phone_number: opts.livePhones?.[sid],
            })),
            next_page_uri: null,
          });
        }
        if (url.startsWith(`${TRUSTHUB}/TrustProducts?`)) {
          return json(200, {
            results: [{ sid: PRODUCT, policy_sid: SHAKEN_POLICY_SID }],
          });
        }
        if (url.includes(`/TrustProducts/${PRODUCT}/EntityAssignments`)) {
          return json(200, { results: [{ sid: "BV1", object_sid: PROFILE }] });
        }
        if (url.startsWith(PRODUCT_CEA)) {
          return json(200, { results: opts.onProduct ?? [], meta: {} });
        }
        if (url.startsWith(PROFILE_CEA)) {
          return json(200, { results: opts.onProfile ?? [], meta: {} });
        }
        return json(404, { message: `unexpected ${method} ${url}` });
      }),
    );
    return { calls };
  }

  const writes = (calls: Call[]) =>
    calls
      .filter((c) => c.method === "POST" || c.method === "DELETE")
      .map((c) => `${c.method} ${c.url}`);

  it("reads both assignment lists BEFORE the number list", async () => {
    // Load-bearing, and it nearly bit us on the first live run: two numbers
    // were bought 15 seconds before it finished. Read this way, a purchase
    // landing mid-pass is in the number list but not in the assignment lists,
    // so it can only be ADDED (an idempotent POST). The other order would see
    // the new assignments without the new number and un-sign a live number.
    const { calls } = stub({ live: ["PN1"], onProfile: [], onProduct: [] });
    await reconcileShakenNumbers();

    const gets = calls.filter((c) => c.method === "GET").map((c) => c.url);
    const numbersAt = gets.findIndex((u) => u.startsWith(NUMBERS));
    const profileAt = gets.findIndex((u) => u.startsWith(PROFILE_CEA));
    const productAt = gets.findIndex((u) => u.startsWith(PRODUCT_CEA));
    expect(profileAt).toBeGreaterThanOrEqual(0);
    expect(productAt).toBeGreaterThanOrEqual(0);
    expect(numbersAt).toBeGreaterThan(profileAt);
    expect(numbersAt).toBeGreaterThan(productAt);
  });

  it("adds profile first, then product — Twilio 400s the other way", async () => {
    const { calls } = stub({ live: ["PN1"], onProfile: [], onProduct: [] });
    const r = await reconcileShakenNumbers();
    expect(r).toMatchObject({ ok: true, added: 2, removed: 0 });
    expect(writes(calls)).toEqual([
      `POST ${PROFILE_CEA}`,
      `POST ${PRODUCT_CEA}`,
    ]);
  });

  it("re-adds only the product for a number the profile already carries", async () => {
    // The 2026-09-02 ten, end to end.
    const { calls } = stub({
      live: ["PN1"],
      onProfile: [{ sid: "RAf1", channel_endpoint_sid: "PN1" }],
      onProduct: [],
    });
    const r = await reconcileShakenNumbers();
    expect(r).toMatchObject({ ok: true, added: 1, removed: 0 });
    expect(writes(calls)).toEqual([`POST ${PRODUCT_CEA}`]);
  });

  it("removes product first, then profile — the reverse of the add order", async () => {
    const { calls } = stub({
      live: [],
      onProfile: [{ sid: "RAf9", channel_endpoint_sid: "PN9" }],
      onProduct: [{ sid: "RAp9", channel_endpoint_sid: "PN9" }],
      writeStatus: () => 204,
    });
    const r = await reconcileShakenNumbers();
    expect(r).toMatchObject({ ok: true, added: 0, removed: 2 });
    expect(writes(calls)).toEqual([
      `DELETE ${PRODUCT_CEA}/RAp9`,
      `DELETE ${PROFILE_CEA}/RAf9`,
    ]);
  });

  it("proceeds on a GENUINE empty account and clears the orphans", async () => {
    // The guard the old script got wrong: it aborted on a zero count, so the
    // 184 assignments left by a released pool would have stayed forever.
    const { calls } = stub({
      live: [],
      onProfile: Array.from({ length: 97 }, (_, i) => ({
        sid: `RAf${i}`,
        channel_endpoint_sid: `PN${i}`,
      })),
      onProduct: Array.from({ length: 87 }, (_, i) => ({
        sid: `RAp${i}`,
        channel_endpoint_sid: `PN${i}`,
      })),
      writeStatus: () => 204,
    });
    const r = await reconcileShakenNumbers();
    expect(r).toMatchObject({ ok: true, added: 0, removed: 184 });
    expect(writes(calls)).toHaveLength(184);
  });

  it("aborts on a FAILED number read and changes nothing", async () => {
    // The distinction that replaced the zero-count guard: a read that errored
    // tells us nothing about the pool, so nothing may be un-signed on it.
    const { calls } = stub({
      numbersStatus: 500,
      onProfile: [{ sid: "RAf9", channel_endpoint_sid: "PN9" }],
      onProduct: [{ sid: "RAp9", channel_endpoint_sid: "PN9" }],
    });
    const r = await reconcileShakenNumbers();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Twilio listing failed \(500\)/);
    expect(writes(calls)).toEqual([]);
  });

  it("aborts when an assignment page fails, before reading numbers at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const json = (status: number, body: unknown) => ({
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
        });
        if (url.startsWith(`${TRUSTHUB}/TrustProducts?`)) {
          return json(200, {
            results: [{ sid: PRODUCT, policy_sid: SHAKEN_POLICY_SID }],
          });
        }
        if (url.includes(`/TrustProducts/${PRODUCT}/EntityAssignments`)) {
          return json(200, { results: [{ sid: "BV1", object_sid: PROFILE }] });
        }
        if (url.startsWith(PROFILE_CEA)) return json(503, {});
        throw new Error(`must not reach ${method} ${url}`);
      }),
    );
    const r = await reconcileShakenNumbers();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("could not list the profile's assignments");
  });

  it("is skipped, not empty, when Twilio is not live", async () => {
    // Mock mode returns no numbers. Treating that as a true zero would strip
    // the parent's Trust Hub from any preview deployment.
    delete process.env.TWILIO_LIVE;
    const { calls } = stub({ live: [], onProfile: [], onProduct: [] });
    const r = await reconcileShakenNumbers();
    expect(r).toEqual({
      ok: false,
      skipped: true,
      error: "Twilio is not live",
    });
    expect(calls).toEqual([]);
  });

  it("keeps going after one failed add and reports the first error", async () => {
    // A partial pass is progress: the next run 30 minutes later retries the
    // rest. Failing the whole pass on one number is how one hiccup became ten
    // permanently unsigned numbers.
    const { calls } = stub({
      live: ["PN1", "PN2"],
      onProfile: [],
      onProduct: [],
      writeStatus: (_m, url) =>
        url.startsWith(PROFILE_CEA) ? 201 : /* product */ 500,
    });
    const r = await reconcileShakenNumbers();
    expect(r.ok).toBe(false);
    expect(r.added).toBe(2); // both profile assignments landed
    expect(r.error).toMatch(/product assign failed/);
    // Both products were still attempted — one failure does not abort the pass.
    expect(writes(calls).filter((w) => w.includes(PRODUCT_CEA))).toHaveLength(
      2,
    );
  });

  it("leaves a profile assignment alone when its product delete failed", async () => {
    // The product depends on the profile, so un-signing the profile half while
    // the product half survives would leave an assignment Twilio cannot honour.
    const { calls } = stub({
      live: [],
      onProfile: [{ sid: "RAf9", channel_endpoint_sid: "PN9" }],
      onProduct: [{ sid: "RAp9", channel_endpoint_sid: "PN9" }],
      writeStatus: (_m, url) => (url.startsWith(PRODUCT_CEA) ? 500 : 204),
    });
    const r = await reconcileShakenNumbers();
    expect(r.ok).toBe(false);
    expect(r.removed).toBe(0);
    expect(writes(calls)).toEqual([`DELETE ${PRODUCT_CEA}/RAp9`]);
  });

  it("counts a 404 delete as removed — already gone is the goal", async () => {
    const { calls } = stub({
      live: [],
      onProfile: [{ sid: "RAf9", channel_endpoint_sid: "PN9" }],
      onProduct: [],
      writeStatus: () => 404,
    });
    const r = await reconcileShakenNumbers();
    expect(r).toMatchObject({ ok: true, removed: 1 });
    expect(writes(calls)).toEqual([`DELETE ${PROFILE_CEA}/RAf9`]);
  });

  it("never throws — a network failure becomes { ok:false }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    await expect(reconcileShakenNumbers()).resolves.toMatchObject({
      ok: false,
      error: "network down",
    });
  });

  // ---- Canadian numbers are not candidates for signing -------------------
  //
  // The pool went mixed on 2026-09-09: 48 US numbers and 9 Canadian, one per
  // province, for the 1,265 Canadian leads. The Trust Hub took the Canadian
  // ones onto the customer profile and refused them on the trust product, so
  // every pass planned the same nine product adds and failed all nine. Not a
  // transient failure — the same result forever, every thirty minutes.

  /** POST bodies only — an ADD carries its PN sid in the body, not the URL
   *  (a DELETE is the other way round: assignment sid, in the URL). */
  const posted = (calls: Call[]) =>
    calls
      .filter((c) => c.method === "POST")
      .map((c) => c.body ?? "")
      .join("\n");

  it("never tries to sign a Canadian number", async () => {
    const { calls } = stub({
      live: ["PNus", "PNca"],
      livePhones: { PNus: "+12125551212", PNca: "+14168675309" },
      onProfile: [],
      onProduct: [],
    });
    await reconcileShakenNumbers();

    expect(posted(calls)).toContain("PNus");
    expect(posted(calls)).not.toContain("PNca");
  });

  it("removes a Canadian number already assigned to the profile", async () => {
    // Self-healing for the nine that got there before the guard existed: they
    // are excluded from the live set, so the plan reads them as no longer ours
    // and takes them off. No migration or manual cleanup needed.
    const { calls } = stub({
      live: ["PNus", "PNca"],
      livePhones: { PNus: "+12125551212", PNca: "+14168675309" },
      onProfile: [on("RAfUS", "PNus"), on("RAfCA", "PNca")],
      onProduct: [on("RApUS", "PNus")],
    });
    await reconcileShakenNumbers();

    const w = writes(calls);
    expect(w.some((c) => c.startsWith("DELETE") && c.includes("RAfCA"))).toBe(
      true,
    );
    // and the US number is left completely alone
    expect(w.some((c) => c.includes("RAfUS"))).toBe(false);
    expect(w.some((c) => c.includes("RApUS"))).toBe(false);
  });

  it("still signs a US number whose area code is unknown to the map", async () => {
    // The conservative half of the guard. If exclusion were "not positively
    // US" instead of "positively Canadian", a US number carrying a brand-new
    // overlay NANPA has activated but nanp-states.ts has not yet learned would
    // be read as foreign and STRIPPED of its A-attestation by the very job
    // meant to protect it.
    const { calls } = stub({
      live: ["PNweird"],
      livePhones: { PNweird: "+12745551212" },
      onProfile: [],
      onProduct: [],
    });
    await reconcileShakenNumbers();

    expect(posted(calls)).toContain("PNweird");
  });

  it("is a clean no-op once the Canadian numbers are off the Trust Hub", async () => {
    // The steady state a mixed pool settles into: the US numbers signed on both
    // containers, the Canadian ones on neither, and nothing left to do. Without
    // the guard this pass would plan nine product adds and fail all nine, on
    // every run, forever.
    const { calls } = stub({
      live: ["PNus", "PNca"],
      livePhones: { PNus: "+12125551212", PNca: "+14168675309" },
      onProfile: [on("RAfUS", "PNus")],
      onProduct: [on("RApUS", "PNus")],
    });
    const result = await reconcileShakenNumbers();

    expect(result).toMatchObject({ ok: true, added: 0, removed: 0 });
    expect(writes(calls)).toEqual([]);
  });
});

/**
 * SHAKEN/STIR is a US framework. The parent Trust Hub accepts a Canadian number
 * onto the supporting customer profile and REFUSES it on the trust product, so
 * a Canadian number in the pool is not a transient failure a retry heals — it
 * fails identically on every pass, forever.
 *
 * Nine Canadian numbers bought on 2026-09-09 (one per province, for the 1,265
 * Canadian leads in CA_MIXED) produced exactly that: profile 57, product 48,
 * and a reconcile that wanted to add the same nine every thirty minutes.
 */
describe("isUnsignableCountry", () => {
  it("is true for a Canadian number", () => {
    expect(isUnsignableCountry("+14168675309")).toBe(true); // 416 Toronto
    expect(isUnsignableCountry("+16045551212")).toBe(true); // 604 Vancouver
  });

  it("is false for a US number", () => {
    expect(isUnsignableCountry("+12125551212")).toBe(false);
    expect(isUnsignableCountry("+19075551212")).toBe(false); // Alaska
  });

  it("is FALSE for an unknown area code, deliberately", () => {
    // Exclusion is the destructive direction: an excluded number reads as "not
    // ours" and the reconcile strips its signing. A US number whose brand-new
    // overlay has not reached nanp-states.ts yet must keep its A-attestation
    // rather than lose it to a stale map. Only a POSITIVE Canadian match is
    // excluded.
    expect(isUnsignableCountry("+18005551212")).toBe(false); // toll-free
    expect(isUnsignableCountry(null)).toBe(false);
    expect(isUnsignableCountry(undefined)).toBe(false);
    expect(isUnsignableCountry("not a number")).toBe(false);
  });
});

describe("assignNumberToShaken and Canadian numbers", () => {
  const OLD_ENV = { ...process.env };
  beforeEach(() => {
    process.env.TWILIO_PARENT_ACCOUNT_SID = "ACparent";
    process.env.TWILIO_PARENT_AUTH_TOKEN = "parent-token";
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllGlobals();
  });

  it("skips a Canadian number without calling Twilio at all", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await assignNumberToShaken("PN1", "+14168675309");

    expect(result.ok).toBe(false);
    // `skipped` is what stops the caller logging a sign FAILURE for something
    // that was never going to work.
    expect(result.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still attempts a US number", async () => {
    // Guard against the skip being too broad. Any fetch at all proves it went
    // down the real path; what Twilio then answers is covered elsewhere.
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await assignNumberToShaken("PN1", "+12125551212");

    expect(result.skipped).not.toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("still attempts when no phone number is supplied", async () => {
    // Back-compat: callers that only hold a sid keep the old behaviour.
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    await assignNumberToShaken("PN1");

    expect(fetchSpy).toHaveBeenCalled();
  });
});
