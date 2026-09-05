import { describe, expect, test, vi } from "vitest";

import {
  deriveElevenLabsRate,
  deriveTwilioRate,
  deriveTwilioRateWithFallback,
  MIN_USAGE_UNITS,
  runCostRatesRefresh,
} from "@/lib/costs/refresh-rates";
import { parseElevenLabsSubscription } from "@/lib/elevenlabs/subscription";
import { parseTwilioUsageBody } from "@/lib/twilio/usage";
import { chatCompletionUsage, responsesUsage } from "@/lib/costs/ai-charges";

/**
 * The daily refresh derives the real rates from the providers' own billing.
 * These fixtures are the live responses observed 2026-09-05 (rounded), so the
 * derivations are pinned to what the accounts actually pay.
 */

const EL_SUBSCRIPTION = {
  tier: "scale_2024_08_10",
  character_limit: 6_269_494,
  character_count: 3_520_965,
  next_invoice: { amount_due_cents: 99_000, subtotal_cents: 99_000 },
  currency: "usd",
  billing_period: "monthly_period",
  status: "active",
};

const TWILIO_OUTBOUND = {
  usage_records: [
    {
      category: "calls-outbound",
      count: "7560",
      count_unit: "calls",
      usage: "8959",
      usage_unit: "minutes",
      price: "107.748",
      price_unit: "usd",
      start_date: "2026-09-01",
      end_date: "2026-09-05",
    },
  ],
};

describe("ElevenLabs $/credit = plan price / credits included", () => {
  test("reads next_invoice.amount_due_cents and character_limit", () => {
    const sub = parseElevenLabsSubscription(EL_SUBSCRIPTION);
    expect(sub?.characterLimit).toBe(6_269_494);
    expect(sub?.nextInvoiceAmountDueCents).toBe(99_000);
    const d = deriveElevenLabsRate(sub);
    expect(d?.key).toBe("elevenlabs_usd_per_credit");
    expect(d?.rate).toBeCloseTo(0.00015791, 8);
    expect(d?.source).toBe("elevenlabs:subscription");
  });

  test("null when the invoice or the limit is missing / zero", () => {
    expect(deriveElevenLabsRate(null)).toBeNull();
    expect(
      deriveElevenLabsRate(
        parseElevenLabsSubscription({
          character_limit: 1000,
          character_count: 0,
        }),
      ),
    ).toBeNull();
    expect(
      deriveElevenLabsRate(
        parseElevenLabsSubscription({
          character_limit: 0,
          character_count: 0,
          next_invoice: { amount_due_cents: 99_000 },
        }),
      ),
    ).toBeNull();
  });
});

describe("Twilio $/unit = usage-record price / usage", () => {
  test("parses the usage record and derives outbound $/min", () => {
    const rec = parseTwilioUsageBody(TWILIO_OUTBOUND);
    expect(rec?.usage).toBe(8959);
    expect(rec?.price).toBeCloseTo(107.748, 3);
    const d = deriveTwilioRate("calls-outbound", "ThisMonth", rec);
    expect(d?.key).toBe("twilio_outbound_usd_per_min");
    expect(d?.rate).toBeCloseTo(0.01203, 5);
    expect(d?.source).toBe("twilio:usage:ThisMonth");
  });

  test("each category maps to its own rate key", () => {
    const rec = (category: string) =>
      parseTwilioUsageBody({
        usage_records: [{ category, usage: "1000", price: "4.4" }],
      });
    expect(
      deriveTwilioRate("calls-inbound", "ThisMonth", rec("calls-inbound"))?.key,
    ).toBe("twilio_inbound_usd_per_min");
    expect(
      deriveTwilioRate(
        "calls-media-stream-minutes",
        "ThisMonth",
        rec("calls-media-stream-minutes"),
      )?.key,
    ).toBe("twilio_media_stream_usd_per_min");
    expect(deriveTwilioRate("lookups", "ThisMonth", rec("lookups"))?.key).toBe(
      "twilio_lookup_usd",
    );
  });

  test(`a period with fewer than ${MIN_USAGE_UNITS} units is too thin`, () => {
    const thin = parseTwilioUsageBody({
      usage_records: [{ category: "lookups", usage: "3", price: "0.024" }],
    });
    expect(deriveTwilioRate("lookups", "ThisMonth", thin)).toBeNull();
    expect(deriveTwilioRate("lookups", "ThisMonth", null)).toBeNull();
  });

  test("falls back to LastMonth when ThisMonth is thin, else gives up", async () => {
    const fetchRecord = vi.fn(async (_c: string, period: string) =>
      period === "ThisMonth"
        ? parseTwilioUsageBody({
            usage_records: [
              { category: "calls-inbound", usage: "40", price: "0.27" },
            ],
          })
        : parseTwilioUsageBody({
            usage_records: [
              { category: "calls-inbound", usage: "1251", price: "8.5068" },
            ],
          }),
    );
    const out = await deriveTwilioRateWithFallback(
      "calls-inbound",
      fetchRecord,
    );
    expect(out.tried).toEqual(["ThisMonth", "LastMonth"]);
    expect(out.derived?.source).toBe("twilio:usage:LastMonth");
    expect(out.derived?.rate).toBeCloseTo(0.0068, 4);

    const none = await deriveTwilioRateWithFallback(
      "lookups",
      async () => null,
    );
    expect(none.derived).toBeNull();
    expect(none.tried).toEqual(["ThisMonth", "LastMonth"]);
  });
});

describe("runCostRatesRefresh upserts what it can and reports the rest", () => {
  test("writes derived rates keyed by rate name; skips thin categories", async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const admin = {
      from: vi.fn(() => ({ upsert })),
    } as unknown as Parameters<typeof runCostRatesRefresh>[0];

    const summary = await runCostRatesRefresh(admin, {
      now: new Date("2026-09-05T04:15:00Z"),
      fetchSubscription: async () =>
        parseElevenLabsSubscription(EL_SUBSCRIPTION),
      fetchUsage: async (category) =>
        category === "calls-outbound"
          ? parseTwilioUsageBody(TWILIO_OUTBOUND)
          : null,
    });

    expect(summary.updated.map((u) => u.key).sort()).toEqual([
      "elevenlabs_usd_per_credit",
      "twilio_outbound_usd_per_min",
    ]);
    expect(summary.skipped.map((s) => s.key).sort()).toEqual([
      "twilio_inbound_usd_per_min",
      "twilio_lookup_usd",
      "twilio_media_stream_usd_per_min",
    ]);
    expect(admin.from).toHaveBeenCalledWith("cost_rates");
    const [rows, opts] = upsert.mock.calls[0] as unknown as [
      { key: string; rate: number; source: string; observed_at: string }[],
      { onConflict: string },
    ];
    expect(opts).toEqual({ onConflict: "key" });
    expect(rows).toHaveLength(2);
    expect(
      rows.every((r) => r.observed_at === "2026-09-05T04:15:00.000Z"),
    ).toBe(true);
  });

  test("throws when the upsert fails (the cron must see a 500, not a silent no-op)", async () => {
    const admin = {
      from: () => ({ upsert: async () => ({ error: { message: "boom" } }) }),
    } as unknown as Parameters<typeof runCostRatesRefresh>[0];
    await expect(
      runCostRatesRefresh(admin, {
        fetchSubscription: async () =>
          parseElevenLabsSubscription(EL_SUBSCRIPTION),
        fetchUsage: async () => null,
      }),
    ).rejects.toThrow(/cost_rates upsert failed/);
  });
});

describe("OpenAI usage parsers", () => {
  test("chat completions: prompt/completion tokens", () => {
    expect(
      chatCompletionUsage({
        usage: { prompt_tokens: 12, completion_tokens: 7 },
      }),
    ).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(chatCompletionUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  test("responses API: input/output tokens + web_search_call count", () => {
    expect(
      responsesUsage({
        usage: { input_tokens: 300, output_tokens: 90 },
        output: [
          { type: "web_search_call" },
          { type: "web_search_call" },
          { type: "message", content: [] },
        ],
      }),
    ).toEqual({ inputTokens: 300, outputTokens: 90, webSearchCalls: 2 });
  });
});
