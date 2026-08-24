import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the two external effects so the orchestrator can be tested in isolation.
const getBalance = vi.fn();
vi.mock("@/lib/elevenlabs/subscription", () => ({
  getElevenLabsCreditBalance: () => getBalance(),
}));
vi.mock("@/lib/elevenlabs/agents", () => ({
  applyConnectedAgentIntegration: vi.fn().mockResolvedValue(undefined),
}));

import { enforceElevenLabsCreditGate } from "@/lib/dialer/credit-gate";

/**
 * Minimal chainable fake of the Supabase service client covering only the
 * calls the guard makes. `tables` supplies canned select results per table;
 * inserts/updates are recorded for assertions.
 */
function makeFakeSupabase(opts: {
  prevState?: string | null;
  activeCampaigns?: Array<{ id: string; owner_id: string; name: string }>;
  lowCreditPaused?: Array<{
    id: string;
    owner_id: string;
    name: string;
    agent_id: string | null;
  }>;
  admins?: Array<{ id: string }>;
}) {
  const notifications: Array<Record<string, unknown>> = [];
  const systemEvents: Array<Record<string, unknown>> = [];
  const campaignUpdates: Array<Record<string, unknown>> = [];
  const statusUpserts: Array<Record<string, unknown>> = [];

  function from(table: string) {
    if (table === "elevenlabs_credit_status") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data:
                opts.prevState === undefined
                  ? null
                  : { state: opts.prevState, read_error_logged_at: null },
            }),
          }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          statusUpserts.push(row);
          return { error: null };
        },
      };
    }
    if (table === "campaigns") {
      return {
        // update(...).eq('status','active').select(...) -> pause path
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, val: string) => {
            let recorded = false;
            const record = () => {
              if (recorded) return;
              recorded = true;
              campaignUpdates.push({ patch, col, val });
            };
            return {
              select: async () => {
                record();
                if (patch.status === "paused") {
                  return { data: opts.activeCampaigns ?? [], error: null };
                }
                return { data: [], error: null };
              },
              // resume path: update(...).eq('id', id) with no .select() —
              // real supabase-js query builders are themselves thenable, so
              // a bare `await` executes the update. Model that here too.
              then: (
                resolve: (value: { data: unknown[]; error: null }) => void,
              ) => {
                record();
                resolve({ data: [], error: null });
              },
            };
          },
        }),
        // select('...').eq('status','paused').eq('paused_reason','low_credits')
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: opts.lowCreditPaused ?? [], error: null }),
          }),
        }),
      };
    }
    if (table === "agents") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { elevenlabs_agent_id: "el_agent_1", tools_enabled: {} },
            }),
          }),
        }),
      };
    }
    if (table === "profiles") {
      return {
        select: () => ({
          eq: async () => ({ data: opts.admins ?? [], error: null }),
        }),
      };
    }
    if (table === "notifications") {
      return {
        insert: async (
          rows: Record<string, unknown> | Record<string, unknown>[],
        ) => {
          for (const r of Array.isArray(rows) ? rows : [rows])
            notifications.push(r);
          return { error: null };
        },
      };
    }
    if (table === "system_events") {
      return {
        insert: async (row: Record<string, unknown>) => {
          systemEvents.push(row);
          return { error: null };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  }

  return {
    client: { from } as never,
    notifications,
    systemEvents,
    campaignUpdates,
    statusUpserts,
  };
}

beforeEach(() => {
  getBalance.mockReset();
});

describe("enforceElevenLabsCreditGate", () => {
  it("fails open (keeps dialing, no pause) when the balance read returns null", async () => {
    getBalance.mockResolvedValue(null);
    const fake = makeFakeSupabase({ prevState: "ok" });
    const res = await enforceElevenLabsCreditGate(fake.client);
    expect(res.dialingBlocked).toBe(false);
    expect(fake.campaignUpdates).toHaveLength(0);
  });

  it("stays blocked (no resume) when read fails and prior state was low", async () => {
    getBalance.mockResolvedValue(null);
    const fake = makeFakeSupabase({ prevState: "low" });
    const res = await enforceElevenLabsCreditGate(fake.client);
    expect(res.dialingBlocked).toBe(true);
    expect(fake.campaignUpdates).toHaveLength(0); // no resume attempted
  });

  it("on entering low: pauses active campaigns and notifies owners + admins", async () => {
    getBalance.mockResolvedValue({
      remaining: 10_000,
      limit: 2_000_000,
      used: 1_990_000,
      tier: "growing_business",
      status: "active",
      resetUnix: null,
    });
    const fake = makeFakeSupabase({
      prevState: "ok",
      activeCampaigns: [
        { id: "c1", owner_id: "u1", name: "Alpha" },
        { id: "c2", owner_id: "u2", name: "Beta" },
      ],
      admins: [{ id: "admin1" }],
    });
    const res = await enforceElevenLabsCreditGate(fake.client);

    expect(res.dialingBlocked).toBe(true);
    // Campaigns were paused with the low_credits reason.
    expect(fake.campaignUpdates[0].patch).toMatchObject({
      status: "paused",
      paused_reason: "low_credits",
    });
    // Each owner + the admin got a notification.
    const recipients = fake.notifications.map((n) => n.user_id).sort();
    expect(recipients).toEqual(["admin1", "u1", "u2"]);
    // An audit event was written.
    expect(
      fake.systemEvents.some((e) => e.kind === "elevenlabs_credits_low"),
    ).toBe(true);
  });

  it("on recovery: resumes low_credits campaigns and notifies", async () => {
    getBalance.mockResolvedValue({
      remaining: 60_000,
      limit: 2_000_000,
      used: 1_940_000,
      tier: "growing_business",
      status: "active",
      resetUnix: null,
    });
    const fake = makeFakeSupabase({
      prevState: "low",
      lowCreditPaused: [
        { id: "c1", owner_id: "u1", name: "Alpha", agent_id: "a1" },
      ],
      admins: [{ id: "admin1" }],
    });
    const res = await enforceElevenLabsCreditGate(fake.client);

    expect(res.dialingBlocked).toBe(false);
    // The paused campaign was flipped back to active.
    expect(
      fake.campaignUpdates.some(
        (u) => (u.patch as Record<string, unknown>).status === "active",
      ),
    ).toBe(true);
    // Owner + admin notified of the resume.
    const recipients = fake.notifications.map((n) => n.user_id).sort();
    expect(recipients).toEqual(["admin1", "u1"]);
  });

  it("warns admins (only) on ok -> warn without pausing", async () => {
    getBalance.mockResolvedValue({
      remaining: 80_000,
      limit: 2_000_000,
      used: 1_920_000,
      tier: "growing_business",
      status: "active",
      resetUnix: null,
    });
    const fake = makeFakeSupabase({
      prevState: "ok",
      admins: [{ id: "admin1" }],
    });
    const res = await enforceElevenLabsCreditGate(fake.client);

    expect(res.dialingBlocked).toBe(false);
    expect(fake.campaignUpdates).toHaveLength(0);
    expect(fake.notifications.map((n) => n.user_id)).toEqual(["admin1"]);
    expect(fake.notifications[0].kind).toBe("elevenlabs_credits_low");
  });
});
