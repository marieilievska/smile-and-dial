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
  /** Make the very first read (elevenlabs_credit_status select) throw, to
   *  exercise the top-level error boundary. */
  throwOnStatusSelect?: boolean;
}) {
  const notifications: Array<Record<string, unknown>> = [];
  const systemEvents: Array<Record<string, unknown>> = [];
  const campaignUpdates: Array<{
    patch: Record<string, unknown>;
    filters: Array<{ col: string; val: unknown }>;
  }> = [];
  const statusUpserts: Array<Record<string, unknown>> = [];

  function from(table: string) {
    if (table === "elevenlabs_credit_status") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => {
              if (opts.throwOnStatusSelect) {
                throw new Error("simulated DB outage");
              }
              return {
                data:
                  opts.prevState === undefined
                    ? null
                    : { state: opts.prevState, read_error_logged_at: null },
              };
            },
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
        // update(...).eq(...)[.eq(...)...] -> either .select() (pause path)
        // or a bare `await` (resume-flip path — real supabase-js query
        // builders are themselves thenable, so no .select() is needed to
        // execute). Every .eq() in the chain is recorded so tests can
        // assert on the exact filters a given update applied.
        update: (patch: Record<string, unknown>) => ({
          eq: (col: string, val: unknown) => {
            const filters: Array<{ col: string; val: unknown }> = [
              { col, val },
            ];
            let recorded = false;
            const record = () => {
              if (recorded) return;
              recorded = true;
              campaignUpdates.push({ patch, filters: [...filters] });
            };
            const chain = {
              eq: (col2: string, val2: unknown) => {
                filters.push({ col: col2, val: val2 });
                return chain;
              },
              select: async () => {
                record();
                if (patch.status === "paused") {
                  return { data: opts.activeCampaigns ?? [], error: null };
                }
                return { data: [], error: null };
              },
              then: (
                resolve: (value: { data: unknown[]; error: null }) => void,
              ) => {
                record();
                resolve({ data: [], error: null });
              },
            };
            return chain;
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
      // select('id').eq('role','admin').eq('active', true)
      return {
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: opts.admins ?? [], error: null }),
          }),
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
    expect(fake.notifications[0].kind).toBe("elevenlabs_credits_warning");
  });

  it("on recovery: guards the resume UPDATE to rows still paused for low credits", async () => {
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
    await enforceElevenLabsCreditGate(fake.client);

    const resumeUpdate = fake.campaignUpdates.find(
      (u) => u.patch.status === "active",
    );
    expect(resumeUpdate).toBeDefined();
    // The per-row flip only targets rows that are STILL paused for low
    // credits (guards against reviving a campaign that left that state
    // between the earlier SELECT and this UPDATE).
    expect(resumeUpdate?.filters).toEqual(
      expect.arrayContaining([
        { col: "status", val: "paused" },
        { col: "paused_reason", val: "low_credits" },
      ]),
    );
  });

  it("fails open and resolves (never rejects) when an unexpected error is thrown", async () => {
    const fake = makeFakeSupabase({
      prevState: "ok",
      throwOnStatusSelect: true,
    });
    const res = await enforceElevenLabsCreditGate(fake.client);
    expect(res).toEqual({
      dialingBlocked: false,
      state: "unknown",
      paused: 0,
      resumed: 0,
    });
  });

  it("still_low: does not re-notify admins or re-log the audit event on a repeat low tick", async () => {
    getBalance.mockResolvedValue({
      remaining: 10_000,
      limit: 2_000_000,
      used: 1_990_000,
      tier: "growing_business",
      status: "active",
      resetUnix: null,
    });
    const fake = makeFakeSupabase({
      prevState: "low",
      // No active campaigns left to pause — this is a repeat "still low"
      // tick, not the initial transition into "low".
      admins: [{ id: "admin1" }],
    });
    const res = await enforceElevenLabsCreditGate(fake.client);

    expect(res.dialingBlocked).toBe(true);
    // The pause action still ran (idempotent), it just matched 0 rows.
    expect(res.paused).toBe(0);
    expect(fake.notifications).toHaveLength(0);
    expect(
      fake.systemEvents.some((e) => e.kind === "elevenlabs_credits_low"),
    ).toBe(false);
  });
});
