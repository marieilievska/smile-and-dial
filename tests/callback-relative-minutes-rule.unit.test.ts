import { describe, expect, it } from "vitest";
import {
  CALLBACK_RELATIVE_MINUTES_RULE,
  CALLBACK_TIME_RULES,
} from "@/lib/elevenlabs/server-tools";

/**
 * The whole point of asking for a minute count is that it needs no per-lead
 * context — so it keeps working where the wall-clock rules do not.
 *
 * `CALLBACK_TIME_RULES` leans on {{lead_timezone}} and {{current_time}}. Those
 * interpolate in the in-call tool's parameter description but NOT in the
 * post-call data-collection description: ElevenLabs returns that description
 * with the literal mustaches still in it (verified again in prod on
 * 2026-09-11, conv_3501m29b6cyze9ntcpt35d0k2760), so the analysis model never
 * learns the lead's clock and falls back on ElevenLabs' own Eastern one.
 *
 * A rule that mentions no zone and no clock cannot be broken that way. If
 * anyone ever adds a {{variable}} to it, this fails.
 */
describe("CALLBACK_RELATIVE_MINUTES_RULE", () => {
  it("carries no {{dynamic_variable}} — that is what makes it survive", () => {
    expect(CALLBACK_RELATIVE_MINUTES_RULE).not.toMatch(/\{\{/);
  });

  it("asks for a count of minutes, not a time", () => {
    expect(CALLBACK_RELATIVE_MINUTES_RULE).toMatch(/minutes/i);
  });

  it("does not disturb the wall-clock rules, whose mustaches are still live in the in-call tool", () => {
    expect(CALLBACK_TIME_RULES).toMatch(/\{\{lead_timezone\}\}/);
    expect(CALLBACK_TIME_RULES).toMatch(/\{\{current_time\}\}/);
  });
});
