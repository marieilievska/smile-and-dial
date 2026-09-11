import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CSV column mapped to "Owner phone" went into the database exactly as the
 * spreadsheet wrote it, while the business phone beside it was normalized. So
 * an owner's line imported as "(415) 555-1000" was stored in a form Call Now
 * now refuses (#532/#534) and the DNC list — which holds E.164 — can never
 * match, even though the very same number typed on the lead page is stored
 * properly.
 *
 * This runs the REAL import against an offline PostgREST stand-in
 * (https://offline.invalid never resolves; a stubbed global fetch answers and
 * records every request), and asserts on the row the import actually sends to
 * the database. Nothing here can reach production.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const rest = createClient("https://offline.invalid", "offline-anon-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return {
      auth: {
        getUser: async () => ({
          data: { user: { id: "user-1" } },
          error: null,
        }),
      },
      from: (table: string) => rest.from(table),
      rpc: (fn: string, args?: Record<string, unknown>) => rest.rpc(fn, args),
    };
  },
}));

import { importLeads } from "@/lib/leads/import-actions";

const LIST = "115a0000-0000-4000-8000-000000000001";

type Recorded = {
  method: string;
  path: string;
  /** The request body as sent: the import upserts an ARRAY of lead rows. */
  rows: Record<string, unknown>[];
};

function standIn() {
  const requests: Recorded[] = [];
  const fetchStub = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init.method ?? "GET").toUpperCase();
      const headers = new Headers(init.headers);
      const raw =
        typeof init.body === "string" && init.body !== ""
          ? JSON.parse(init.body)
          : null;
      requests.push({
        method,
        path: url.pathname,
        rows: raw === null ? [] : Array.isArray(raw) ? raw : [raw],
      });

      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });
      const one = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
      const table = url.pathname.replace(/^\/rest\/v1\//, "");

      if (url.pathname.startsWith("/rest/v1/rpc/")) return json(null);
      if (method === "GET") {
        // The list being imported into must exist; nothing else is on file.
        if (table === "lists") {
          const row = { id: LIST };
          return json(one ? row : [row]);
        }
        return json(one ? null : []);
      }
      if ((headers.get("prefer") ?? "").includes("return=representation")) {
        const row = { id: "lead-1", business_phone: null, list_id: LIST };
        return json(one ? row : [row], 201);
      }
      return new Response(null, { status: method === "POST" ? 201 : 204 });
    },
  );
  return { requests, fetchStub };
}

/** The lead rows the import sent to the database. */
const importedRows = (reqs: Recorded[]) =>
  reqs
    .filter((r) => r.method === "POST" && r.path === "/rest/v1/leads")
    .flatMap((r) => r.rows);

/** Run one CSV row through the real import. */
async function importOneRow(row: {
  Phone: string;
  "Owner phone": string;
}): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  const db = standIn();
  vi.stubGlobal("fetch", db.fetchStub);
  const res = await importLeads({
    listId: LIST,
    dedup: "skip",
    mapping: {
      Phone: "field:business_phone",
      "Owner phone": "field:owner_phone",
    },
    rows: [row],
  });
  return { rows: importedRows(db.requests), error: res.error };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://offline.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "offline-service-key");
  vi.stubEnv("TWILIO_LIVE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("an imported owner phone is stored the same way a typed one is", () => {
  it("normalizes it to E.164, like the business phone beside it", async () => {
    const { rows, error } = await importOneRow({
      Phone: "(205) 259-8928",
      "Owner phone": "(415) 555-1000",
    });

    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      business_phone: "+12052598928",
      owner_phone: "+14155551000",
    });
  });

  it.each([
    ["a foreign number", "+44 20 7946 0958"],
    ["a number nobody has", "111-111-1111"],
    ["a word", "front desk"],
  ])(
    "leaves %s exactly as the sheet wrote it, rather than inventing a +1",
    async (_what, owner) => {
      // The import never drops a row over a secondary field, so an owner
      // number it can't read is kept as text — visible, and refused at dial
      // time — instead of being turned into a real US number belonging to
      // somebody else, which is what a looser rule did to business numbers
      // before #518.
      const { rows, error } = await importOneRow({
        Phone: "(205) 259-8928",
        "Owner phone": owner,
      });

      expect(error).toBeNull();
      expect(rows[0]).toMatchObject({
        business_phone: "+12052598928",
        owner_phone: owner,
      });
    },
  );
});
