import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may permanently delete a RELEASED number from the pool.
 *
 * The Delete button and its server action were both gated on `isSuperAdmin`,
 * which is stricter than the table itself: `twilio_numbers_delete` is
 * `owner_id = auth.uid() or is_admin(auth.uid())` (20260831120000), so an
 * admin has always been allowed to delete a number THEY own — the app just
 * never offered it. A capability RLS grants but the UI hides is the failure
 * the roles module warns about in its own header comment, and it is why a
 * released number sat in the pool with no way to clear it.
 *
 * So: delete moves to the admin tier (admin or super admin), scoped to what
 * the caller can see. "Sync from Twilio" does NOT move — it reconciles the
 * entire shared Twilio account rather than one person's numbers, so it stays
 * super-admin only. Both halves are pinned here.
 *
 * Ownership is enforced by RLS, not by this gate: the action looks the number
 * up through the CALLER's client, so an id they cannot see reads back as
 * missing and the delete stops there. That read is what keeps an admin from
 * deleting somebody else's number, and it is asserted below.
 *
 * Runs the REAL server actions against an offline PostgREST stand-in
 * (https://offline.invalid never resolves; a stubbed global fetch answers and
 * records every request), so nothing here can reach production or release,
 * delete, or otherwise touch a real phone number.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const roleHolder = vi.hoisted(() => ({ role: "member" }));

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

import {
  deleteTwilioNumber,
  syncFromTwilio,
} from "@/lib/twilio/number-actions";

const NUMBER = "0000ab00-0000-4000-8000-000000000001";

type Recorded = { method: string; path: string };

/** An offline PostgREST. `profiles` answers with the role under test;
 *  `twilio_numbers` answers with `number`, or nothing when it is null —
 *  which is how RLS hides a row the caller does not own. */
function standIn(opts: { number: Record<string, unknown> | null }) {
  const requests: Recorded[] = [];
  const fetchStub = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init.method ?? "GET").toUpperCase();
      const headers = new Headers(init.headers);
      requests.push({ method, path: url.pathname });

      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });
      const one = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
      const table = url.pathname.replace(/^\/rest\/v1\//, "");

      if (method === "GET") {
        if (table === "profiles") {
          const row = { role: roleHolder.role };
          return json(one ? row : [row]);
        }
        if (table === "twilio_numbers") {
          if (!opts.number) return json(one ? null : []);
          return json(one ? opts.number : [opts.number]);
        }
        return json(one ? null : []);
      }
      return new Response(null, { status: method === "POST" ? 201 : 204 });
    },
  );
  return { requests, fetchStub };
}

/** A released number, ready to be deleted. Nothing to tear down at Twilio or
 *  ElevenLabs, so a caller past the gate goes straight to the delete. */
const RELEASED = {
  id: NUMBER,
  phone_number: "+15109837276",
  twilio_sid: null,
  released_at: "2026-09-11T16:43:06.798+00:00",
  elevenlabs_phone_number_id: null,
};

/** Same number, still in the pool. A caller past the gate stops on the
 *  "release it first" rule — which is how these tests tell "the gate let me
 *  through" apart from "the gate turned me away" without deleting anything. */
const IN_POOL = { ...RELEASED, released_at: null };

const deletes = (reqs: Recorded[]) =>
  reqs.filter(
    (r) => r.method === "DELETE" && r.path === "/rest/v1/twilio_numbers",
  );

beforeEach(() => {
  roleHolder.role = "member";
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://offline.invalid");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "offline-service-key");
  vi.stubEnv("ELEVENLABS_LIVE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("deleting a released number", () => {
  it.each([
    ["an admin", "admin"],
    ["a super admin", "super_admin"],
  ])("%s gets past the gate", async (_who, role) => {
    roleHolder.role = role;
    const db = standIn({ number: IN_POOL });
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await deleteTwilioNumber(NUMBER);

    // Past the gate: stopped by the release rule, not by permission.
    expect(res.error).toBe("Release the number before deleting it.");
    expect(deletes(db.requests)).toEqual([]);
  });

  it.each([
    ["an admin", "admin"],
    ["a super admin", "super_admin"],
  ])("%s can delete one they can see", async (_who, role) => {
    roleHolder.role = role;
    const db = standIn({ number: RELEASED });
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await deleteTwilioNumber(NUMBER);

    expect(res.error).toBeNull();
    expect(deletes(db.requests)).toHaveLength(1);
  });

  it("a member is turned away and nothing is deleted", async () => {
    roleHolder.role = "member";
    const db = standIn({ number: RELEASED });
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await deleteTwilioNumber(NUMBER);

    expect(res.error).toBe("You are not authorized.");
    expect(deletes(db.requests)).toEqual([]);
  });

  it("an admin cannot delete a number RLS hides from them", async () => {
    roleHolder.role = "admin";
    const db = standIn({ number: null });
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await deleteTwilioNumber(NUMBER);

    expect(res.error).toBe("That number no longer exists.");
    expect(deletes(db.requests)).toEqual([]);
  });
});

describe("Sync from Twilio stays super-admin only", () => {
  it.each([
    ["a member", "member"],
    ["an admin", "admin"],
  ])("%s is turned away", async (_who, role) => {
    roleHolder.role = role;
    const db = standIn({ number: RELEASED });
    vi.stubGlobal("fetch", db.fetchStub);

    const res = await syncFromTwilio();

    expect(res.error).toBe("Only a super admin can do that.");
    expect(res.added).toBe(0);
  });
});
