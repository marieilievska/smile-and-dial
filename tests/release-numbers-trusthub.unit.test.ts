import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * `scripts/release-numbers.mjs` hands the whole number pool back. The half that
 * kept silently failing is the Trust Hub cleanup.
 *
 * Twilio hangs two assignment collections off the same TrustProduct:
 * `EntityAssignments` (end-users, supporting documents, the linked
 * CustomerProfile) and `ChannelEndpointAssignments` (phone numbers, keyed by
 * `channel_endpoint_sid`). Reading the wrong one returns 200 with a valid list
 * of the wrong things — so the filter matches nothing, the script reports
 * "0 ours", and every assignment is left behind. It shipped that way through
 * two full wipes on 2026-09-08, orphaning 184 then 176 assignments.
 *
 * There is no way to assert this against the live API without releasing real
 * numbers, and the script is a one-shot node process rather than an importable
 * module, so these read source text. What actually regresses is someone
 * rewriting the script from memory with the wrong resource, and that is
 * visible in the source.
 */
const SRC = readFileSync("scripts/release-numbers.mjs", "utf8");

/** Source with `//` and block comments stripped, so the header explaining the
 *  trap can never satisfy a test asserting the code avoids it.
 *
 *  The `[^:]` guard matters: a naive /\/\/.../ also eats `https://…`, which
 *  silently deleted the ElevenLabs delete URL this file asserts on. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const BODY = code(SRC);

describe("release-numbers.mjs cleans the Trust Hub it was asked to clean", () => {
  it("reads phone-number assignments from ChannelEndpointAssignments", () => {
    expect(BODY).toContain("ChannelEndpointAssignments?PageSize=200");
  });

  it("filters them by channel_endpoint_sid, not object_sid", () => {
    // The key half of the bug. `object_sid` is undefined on a
    // ChannelEndpointAssignment, so `ourSids.has(undefined)` is silently false
    // and the correct endpoint still yields an empty set.
    expect(BODY).toContain("ourSids.has(a.channel_endpoint_sid)");
    expect(BODY).not.toContain("ourSids.has(a.object_sid)");
  });

  it("DELETEs against ChannelEndpointAssignments on both containers", () => {
    expect(BODY).toMatch(
      /TrustProducts\/\$\{tp\.sid\}\/ChannelEndpointAssignments\/\$\{a\.sid\}/,
    );
    expect(BODY).toMatch(
      /CustomerProfiles\/\$\{profileSid\}\/ChannelEndpointAssignments\/\$\{a\.sid\}/,
    );
    // No phone-number delete may go to the entity collection.
    expect(BODY).not.toMatch(/EntityAssignments\/\$\{a\.sid\}/);
  });

  it("still resolves the CustomerProfile via EntityAssignments", () => {
    // This read is CORRECT — a linked profile IS an entity. A blanket
    // find-and-replace of the resource name breaks profile resolution, and
    // then every profile-side delete 404s against `undefined`.
    expect(BODY).toMatch(
      /TrustProducts\/\$\{tp\.sid\}\/EntityAssignments\?PageSize=200/,
    );
    expect(BODY).toContain("object_sid");
  });
});

describe("release-numbers.mjs cannot reach another ElevenLabs workspace", () => {
  it("aborts when the workspace holds a number we do not own", () => {
    // The shared Referrizer workspace carries ~90 numbers for other
    // departments. This guard is what makes a wrong API key safe.
    expect(BODY).toContain("strangers.length > 0");
    expect(BODY).toContain("process.exit(1)");
  });

  it("deletes ElevenLabs objects by id from our own table", () => {
    // Never by enumerating the workspace. Even against the wrong key this can
    // only touch numbers this app recorded.
    expect(BODY).toContain("phone-numbers/${n.elevenlabs_phone_number_id}");
  });

  it("requires --yes before anything destructive", () => {
    expect(BODY).toContain('process.argv.includes("--yes")');
    expect(BODY).toContain("if (!LIVE)");
  });
});

describe("release-numbers.mjs is portable", () => {
  it("resolves the repo root from its own location, not a hardcoded path", () => {
    // It lived in a scratchpad with an absolute Windows path baked in, which
    // is part of why it kept being rewritten from memory instead of reused.
    expect(BODY).toContain("fileURLToPath(import.meta.url)");
    expect(BODY).not.toMatch(/C:\/Users\//);
  });
});
