import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Guards for the two ways a person gets into this app: an invitation, and a
 * password reset.
 *
 * Both failed in production for the same two reasons, months apart.
 *
 *   1. The link pointed at the wrong host. Supabase falls back to the
 *      project's "Site URL" when a call omits `redirectTo`, and that has been
 *      localhost on this project — so the email arrived and the link went
 *      nowhere. src/lib/app-url.ts exists because of it.
 *   2. The link expired. Supabase invite tokens are single-use and die on the
 *      project's email-OTP clock, so an invitation left until the next morning
 *      is dead — and until now the app offered no way to issue a fresh one.
 *      The first super-admin invite was lost exactly this way.
 *
 * These scan the source rather than mock GoTrue: what needs pinning is that
 * no call site is left bare, which is a property of the code, not of a run.
 */

const USERS = "src/lib/users/actions.ts";
const AUTH = "src/lib/auth/actions.ts";
const PAGE = "src/app/(app)/settings/users/page.tsx";
const ROW = "src/app/(app)/settings/users/user-row-actions.tsx";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

/** Every argument list passed to one of the link-sending GoTrue calls. */
function linkCalls(src: string): string[] {
  const re = /\.(inviteUserByEmail|resetPasswordForEmail)\([\s\S]*?\);/g;
  return [...src.matchAll(re)].map((m) => m[0]);
}

describe("no auth email is sent without a redirect", () => {
  it.each([USERS, AUTH])("%s", (rel) => {
    const calls = linkCalls(read(rel));
    // A regex that stops matching would make this vacuously pass.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, call).toMatch(/redirectTo/);
    }
  });
});

describe("the redirect target is the route that exists", () => {
  const src = read(USERS);

  it("routes through /auth/confirm to /auth/set-password", () => {
    // /auth/confirm exchanges the token for a session, then forwards. Sending
    // people straight to /auth/set-password would land them with no session.
    expect(src).toMatch(/\/auth\/confirm\?next=\/auth\/set-password/);
  });

  it("builds it from the canonical domain, in one place", () => {
    expect(src).toMatch(/function authLinkRedirect\(\)/);
    expect(src).toMatch(/const base = appBaseUrl\(\);/);
    // Exactly one literal — a second would be the copy that drifts.
    expect(src.match(/\/auth\/confirm\?next=/g)).toHaveLength(1);
  });

  it("omits it locally rather than inventing a host", () => {
    expect(src).toMatch(/return base \? [\s\S]{0,80} : undefined;/);
  });
});

describe("an expired invitation can be re-issued", () => {
  const src = read(USERS);

  it("exports resendInvite, gated to user managers", () => {
    const fn = /export async function resendInvite\(([\s\S]*?)\n}/.exec(src);
    expect(fn, "resendInvite is missing").not.toBeNull();
    expect(fn![0]).toMatch(/requireUserManager/);
    expect(fn![0]).toMatch(/inviteUserByEmail/);
  });

  it("reads the address off the auth record, not off the caller", () => {
    // The row on screen can be stale; auth.users cannot. Also stops a crafted
    // request from mailing an invitation to an arbitrary address.
    const fn = /export async function resendInvite\(([\s\S]*?)\n}/.exec(
      src,
    )![0];
    expect(fn).toMatch(/getUserById\(userId\)/);
    expect(fn).toMatch(/authUser\.email/);
  });

  it("refuses someone who already set a password", () => {
    const fn = /export async function resendInvite\(([\s\S]*?)\n}/.exec(
      src,
    )![0];
    expect(fn).toMatch(/email_confirmed_at/);
    expect(fn).toMatch(/password reset instead/);
  });
});

describe("the users page shows who never accepted", () => {
  it("derives pending from auth.users, which profiles does not mirror", () => {
    const src = read(PAGE);
    expect(src).toMatch(/createAdminClient\(\)\.auth\.admin\.listUsers/);
    expect(src).toMatch(/!u\.email_confirmed_at/);
    expect(src).toMatch(/pendingInvite=\{pendingInvite\.has\(u\.id\)\}/);
  });

  it("offers the resend in place of a reset for those rows", () => {
    const src = read(ROW);
    expect(src).toMatch(/\{pendingInvite \? \(/);
    expect(src).toMatch(/resendInvite\(userId\)/);
    // The reset stays for everyone else -- it is still the right tool there.
    expect(src).toMatch(/sendPasswordReset\(email\)/);
  });
});
