import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  clearEffectiveRates,
  currentEffectiveRates,
  elevenLabsUsdPerCredit,
  priceElevenLabsCredits,
  priceElevenLabsNativeTwilio,
  priceTwilioCall,
  priceTwilioMediaStream,
  setEffectiveRates,
  twilioInboundUsdPerMinute,
  twilioLookupUsd,
  twilioMediaStreamUsdPerMinute,
  twilioNumberMonthlyUsd,
  twilioOutboundUsdPerMinute,
} from "../src/lib/costs/rates";

/**
 * Provider rates resolve stored (cost_rates) → env override → verified
 * default. Twilio voice is priced by DIRECTION (inbound is ~half the outbound
 * rate) and every ElevenLabs-native call ALSO pays a media-stream minute per
 * call minute — which nothing priced before 2026-09-05.
 */

const ENV_KEYS = [
  "TWILIO_VOICE_USD_PER_MINUTE",
  "TWILIO_INBOUND_USD_PER_MINUTE",
  "TWILIO_MEDIA_STREAM_USD_PER_MINUTE",
  "TWILIO_LOOKUP_USD",
  "ELEVENLABS_USD_PER_CREDIT",
  "TWILIO_NUMBER_MONTHLY_COST",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  clearEffectiveRates();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  clearEffectiveRates();
});

describe("defaults are the figures verified against the providers on 2026-09-05", () => {
  test("ElevenLabs $990 / 6,269,494 credits", () => {
    expect(elevenLabsUsdPerCredit()).toBe(0.00015791);
  });
  test("Twilio outbound / inbound / media stream / lookup", () => {
    expect(twilioOutboundUsdPerMinute()).toBe(0.01203);
    expect(twilioInboundUsdPerMinute()).toBe(0.0068);
    expect(twilioMediaStreamUsdPerMinute()).toBe(0.0044);
    expect(twilioLookupUsd()).toBe(0.008);
  });
  test("number rental stays at the negotiated $0.04 and is never derived", () => {
    expect(twilioNumberMonthlyUsd()).toBe(0.04);
    setEffectiveRates({
      twilio_outbound_usd_per_min: 9,
    } as never);
    expect(twilioNumberMonthlyUsd()).toBe(0.04);
  });
});

describe("fallback order: stored effective rate → env override → default", () => {
  test("env overrides the default", () => {
    process.env.TWILIO_VOICE_USD_PER_MINUTE = "0.02";
    process.env.ELEVENLABS_USD_PER_CREDIT = "0.0002";
    expect(twilioOutboundUsdPerMinute()).toBe(0.02);
    expect(elevenLabsUsdPerCredit()).toBe(0.0002);
  });

  test("a stored effective rate overrides the env override", () => {
    process.env.TWILIO_VOICE_USD_PER_MINUTE = "0.02";
    setEffectiveRates({ twilio_outbound_usd_per_min: 0.0115 });
    expect(twilioOutboundUsdPerMinute()).toBe(0.0115);
    // Untouched keys still fall through.
    expect(twilioInboundUsdPerMinute()).toBe(0.0068);
  });

  test("clearing the stored rates restores env, then default", () => {
    setEffectiveRates({ twilio_media_stream_usd_per_min: 0.005 });
    expect(twilioMediaStreamUsdPerMinute()).toBe(0.005);
    clearEffectiveRates();
    expect(twilioMediaStreamUsdPerMinute()).toBe(0.0044);
  });

  test("garbage stored values are dropped, not installed", () => {
    setEffectiveRates({
      twilio_lookup_usd: -1,
      elevenlabs_usd_per_credit: Number.NaN,
      twilio_inbound_usd_per_min: "0.01" as unknown as number,
    });
    expect(currentEffectiveRates()).toEqual({});
    expect(twilioLookupUsd()).toBe(0.008);
  });

  test("a bad env value falls back to the default", () => {
    process.env.TWILIO_LOOKUP_USD = "not-a-number";
    expect(twilioLookupUsd()).toBe(0.008);
  });
});

describe("Twilio pricing is direction-aware and includes the media stream", () => {
  test("whole minutes, rounded up: 61 s is 2 minutes", () => {
    expect(priceTwilioCall(61, "outbound")).toBeCloseTo(2 * 0.01203, 4);
    expect(priceTwilioCall(60, "outbound")).toBeCloseTo(0.01203, 4);
    expect(priceTwilioCall(0, "outbound")).toBe(0);
    expect(priceTwilioCall(null)).toBe(0);
  });

  test("inbound is priced at the inbound rate", () => {
    expect(priceTwilioCall(120, "inbound")).toBeCloseTo(2 * 0.0068, 4);
    expect(priceTwilioCall(120, "inbound")).toBeLessThan(
      priceTwilioCall(120, "outbound"),
    );
  });

  test("anything that is not literally 'inbound' prices as outbound", () => {
    expect(priceTwilioCall(120)).toBeCloseTo(2 * 0.01203, 4);
    expect(priceTwilioCall(120, null)).toBeCloseTo(2 * 0.01203, 4);
    expect(priceTwilioCall(120, "weird")).toBeCloseTo(2 * 0.01203, 4);
  });

  test("the media stream bills the same minute count at its own rate", () => {
    expect(priceTwilioMediaStream(61)).toBeCloseTo(2 * 0.0044, 4);
    expect(priceTwilioMediaStream(0)).toBe(0);
  });

  test("an ElevenLabs-native call pays voice + media stream", () => {
    const out = priceElevenLabsNativeTwilio(150, "outbound");
    expect(out.call).toBeCloseTo(3 * 0.01203, 4);
    expect(out.mediaStream).toBeCloseTo(3 * 0.0044, 4);
    expect(out.total).toBeCloseTo(out.call + out.mediaStream, 4);

    const inb = priceElevenLabsNativeTwilio(150, "inbound");
    expect(inb.call).toBeCloseTo(3 * 0.0068, 4);
    expect(inb.mediaStream).toBeCloseTo(3 * 0.0044, 4);
  });

  test("pricing follows a stored effective rate", () => {
    setEffectiveRates({
      twilio_outbound_usd_per_min: 0.01,
      twilio_media_stream_usd_per_min: 0.004,
    });
    const out = priceElevenLabsNativeTwilio(60, "outbound");
    expect(out.call).toBe(0.01);
    expect(out.mediaStream).toBe(0.004);
    expect(out.total).toBe(0.014);
  });
});

describe("ElevenLabs credits price at the effective $/credit", () => {
  test("default rate", () => {
    expect(priceElevenLabsCredits(1000)).toBeCloseTo(0.1579, 4);
    expect(priceElevenLabsCredits(0)).toBe(0);
    expect(priceElevenLabsCredits(null)).toBe(0);
  });
  test("stored rate", () => {
    setEffectiveRates({ elevenlabs_usd_per_credit: 0.0002 });
    expect(priceElevenLabsCredits(1000)).toBe(0.2);
  });
});
