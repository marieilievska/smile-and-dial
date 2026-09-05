import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assignmentSidsFor,
  SHAKEN_POLICY_SID,
  unassignNumberFromShaken,
} from "@/lib/twilio/shaken";

/**
 * Un-signing a released number from SHAKEN/STIR on the parent Trust Hub.
 * Everything runs against a stubbed fetch — no Twilio, no network.
 */

const TRUSTHUB = "https://trusthub.twilio.com/v1";
const PRODUCT = "BUproduct";
const PROFILE = "BUprofile";
const RELEASED = "PNreleased";
const PRODUCT_CEA = `${TRUSTHUB}/TrustProducts/${PRODUCT}/ChannelEndpointAssignments`;
const PROFILE_CEA = `${TRUSTHUB}/CustomerProfiles/${PROFILE}/ChannelEndpointAssignments`;

const OLD_ENV = {
  TWILIO_LIVE: process.env.TWILIO_LIVE,
  TWILIO_PARENT_ACCOUNT_SID: process.env.TWILIO_PARENT_ACCOUNT_SID,
  TWILIO_PARENT_AUTH_TOKEN: process.env.TWILIO_PARENT_AUTH_TOKEN,
};

beforeEach(() => {
  process.env.TWILIO_LIVE = "live";
  process.env.TWILIO_PARENT_ACCOUNT_SID = "ACparent";
  process.env.TWILIO_PARENT_AUTH_TOKEN = "parent-token";
});
afterEach(() => {
  for (const [k, v] of Object.entries(OLD_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

type Assignment = { sid: string; channel_endpoint_sid: string };
type Call = { method: string; url: string };

/** A fetch stub that plays the parent Trust Hub: product discovery, the
 *  product's profile, and paged assignment lists for both containers. Each
 *  container's pages chain through `meta.next_page_url` (absolute, like
 *  Twilio's). DELETE status is per-URL so a test can fail one container. */
function stubTrustHub(opts: {
  productPages?: Assignment[][];
  profilePages?: Assignment[][];
  deleteStatus?: (url: string) => number;
  /** Status for a ChannelEndpointAssignments page GET (default 200). */
  listStatus?: (url: string) => number;
}): { calls: Call[] } {
  const calls: Call[] = [];
  const productPages = opts.productPages ?? [[]];
  const profilePages = opts.profilePages ?? [[]];
  const deleteStatus = opts.deleteStatus ?? (() => 204);
  const listStatus = opts.listStatus ?? (() => 200);

  const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const pageOf = (base: string, pages: Assignment[][], index: number) => ({
    meta: {
      next_page_url:
        index + 1 < pages.length
          ? `${base}?PageSize=200&PageToken=p${index + 1}`
          : null,
    },
    results: pages[index] ?? [],
  });
  const pageIndex = (url: string) =>
    Number(new URL(url).searchParams.get("PageToken")?.slice(1) ?? 0);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (method === "DELETE") return json(deleteStatus(url), {});
      if (url.startsWith(`${TRUSTHUB}/TrustProducts?`)) {
        return json(200, {
          results: [
            { sid: "BUother", policy_sid: "RNother" },
            { sid: PRODUCT, policy_sid: SHAKEN_POLICY_SID },
          ],
        });
      }
      if (url.includes(`/TrustProducts/${PRODUCT}/EntityAssignments`)) {
        return json(200, { results: [{ sid: "BV1", object_sid: PROFILE }] });
      }
      if (url.startsWith(PRODUCT_CEA)) {
        return json(
          listStatus(url),
          pageOf(PRODUCT_CEA, productPages, pageIndex(url)),
        );
      }
      if (url.startsWith(PROFILE_CEA)) {
        return json(
          listStatus(url),
          pageOf(PROFILE_CEA, profilePages, pageIndex(url)),
        );
      }
      return json(404, { message: `unexpected ${method} ${url}` });
    }),
  );
  return { calls };
}

const deletes = (calls: Call[]) =>
  calls.filter((c) => c.method === "DELETE").map((c) => c.url);

describe("assignmentSidsFor", () => {
  it("picks only the assignments that point at the number, in order", () => {
    const sids = assignmentSidsFor(
      [
        { sid: "RA1", channel_endpoint_sid: "PNother" },
        { sid: "RA2", channel_endpoint_sid: RELEASED },
        { sid: "RA3" },
        { sid: "RA4", channel_endpoint_sid: RELEASED },
      ],
      RELEASED,
    );
    expect(sids).toEqual(["RA2", "RA4"]);
  });

  it("is empty when nothing points at the number", () => {
    expect(
      assignmentSidsFor(
        [{ sid: "RA1", channel_endpoint_sid: "PNx" }],
        RELEASED,
      ),
    ).toEqual([]);
    expect(assignmentSidsFor([], RELEASED)).toEqual([]);
  });
});

describe("unassignNumberFromShaken", () => {
  it("is skipped (not a failure) when the parent creds are missing", async () => {
    delete process.env.TWILIO_PARENT_AUTH_TOKEN;
    const { calls } = stubTrustHub({});
    const r = await unassignNumberFromShaken(RELEASED);
    expect(r).toEqual({
      ok: false,
      skipped: true,
      error: "parent Trust Hub token not configured",
    });
    expect(calls).toEqual([]);
  });

  it("is skipped when Twilio is not live — a mock release never gave the number up", async () => {
    delete process.env.TWILIO_LIVE;
    const { calls } = stubTrustHub({});
    const r = await unassignNumberFromShaken(RELEASED);
    expect(r.skipped).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses a missing sid without touching the network", async () => {
    const { calls } = stubTrustHub({});
    expect((await unassignNumberFromShaken(null)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("pages through every assignment and deletes product first, then profile", async () => {
    const { calls } = stubTrustHub({
      // The released number sits on the product's SECOND page — a single-page
      // read would miss it and leave the number signed.
      productPages: [
        [{ sid: "RAp1", channel_endpoint_sid: "PNother" }],
        [{ sid: "RAp2", channel_endpoint_sid: RELEASED }],
      ],
      profilePages: [
        [
          { sid: "RAf1", channel_endpoint_sid: RELEASED },
          { sid: "RAf2", channel_endpoint_sid: "PNother" },
          { sid: "RAf3", channel_endpoint_sid: RELEASED },
        ],
      ],
    });

    const r = await unassignNumberFromShaken(RELEASED);
    expect(r).toEqual({ ok: true, error: null });

    // Both product pages were read (the second via its next_page_url).
    expect(
      calls.filter((c) => c.method === "GET" && c.url.startsWith(PRODUCT_CEA)),
    ).toHaveLength(2);
    expect(calls.some((c) => c.url.includes("PageToken=p1"))).toBe(true);

    // Reverse of the add order: product, then profile; every match deleted.
    expect(deletes(calls)).toEqual([
      `${PRODUCT_CEA}/RAp2`,
      `${PROFILE_CEA}/RAf1`,
      `${PROFILE_CEA}/RAf3`,
    ]);
  });

  it("treats a number that was never signed as already done", async () => {
    const { calls } = stubTrustHub({
      productPages: [[{ sid: "RAp1", channel_endpoint_sid: "PNother" }]],
      profilePages: [[{ sid: "RAf1", channel_endpoint_sid: "PNother" }]],
    });
    const r = await unassignNumberFromShaken(RELEASED);
    expect(r).toEqual({ ok: true, error: null });
    expect(deletes(calls)).toEqual([]);
  });

  it("treats a 404 on delete as already gone", async () => {
    const { calls } = stubTrustHub({
      productPages: [[{ sid: "RAp1", channel_endpoint_sid: RELEASED }]],
      profilePages: [[{ sid: "RAf1", channel_endpoint_sid: RELEASED }]],
      deleteStatus: () => 404,
    });
    const r = await unassignNumberFromShaken(RELEASED);
    expect(r).toEqual({ ok: true, error: null });
    expect(deletes(calls)).toHaveLength(2);
  });

  it("stops at a failed product delete and leaves the profile alone", async () => {
    const { calls } = stubTrustHub({
      productPages: [[{ sid: "RAp1", channel_endpoint_sid: RELEASED }]],
      profilePages: [[{ sid: "RAf1", channel_endpoint_sid: RELEASED }]],
      deleteStatus: (url) => (url.startsWith(PRODUCT_CEA) ? 500 : 204),
    });
    const r = await unassignNumberFromShaken(RELEASED);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBeUndefined();
    expect(r.error).toBe("product unassign failed (500)");
    // The profile assignment must still be there — the product depends on it.
    expect(deletes(calls)).toEqual([`${PRODUCT_CEA}/RAp1`]);
  });

  it("reports a failed listing instead of guessing from a partial read", async () => {
    const { calls } = stubTrustHub({
      // The released number is on page two, and page two 503s: a partial read
      // must not be mistaken for "nothing to un-sign".
      productPages: [[], [{ sid: "RAp2", channel_endpoint_sid: RELEASED }]],
      profilePages: [[{ sid: "RAf1", channel_endpoint_sid: RELEASED }]],
      listStatus: (url) => (url.includes("PageToken=p1") ? 503 : 200),
    });
    const r = await unassignNumberFromShaken(RELEASED);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("could not list the product's assignments");
    expect(deletes(calls)).toEqual([]);
  });

  it("never throws — a network failure becomes { ok:false }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    await expect(unassignNumberFromShaken(RELEASED)).resolves.toMatchObject({
      ok: false,
      error: "network down",
    });
  });
});
