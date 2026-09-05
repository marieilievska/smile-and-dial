import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const DIAL_ROUTE = read("../src/app/api/twilio/voice-browser-dial/route.ts");
const COMPLETE_ROUTE = read(
  "../src/app/api/twilio/voice-browser-dial/complete/route.ts",
);
const HUMAN_CALL = read("../src/lib/twilio/human-call.ts");
const DISPOSITION = read("../src/lib/calls/human-disposition.ts");
const USER_ACTIONS = read("../src/lib/users/actions.ts");
const APP_LAYOUT = read("../src/app/(app)/layout.tsx");

/**
 * The browser-dial paths were only ever exercised by a single admin. With
 * members and more admins arriving, these guard the wiring that binds a human
 * call to the signed-in user and keeps it inside their leads, their campaigns'
 * numbers, and the DNC list — none of which an e2e test can cover without a
 * billable Twilio call.
 */
describe("voice-browser-dial route", () => {
  it("derives the caller from Twilio's From=client:<id>, not the browser's userId", () => {
    expect(DIAL_ROUTE).toContain("parseClientIdentity(params.From)");
    expect(DIAL_ROUTE).toContain("authorizeHumanDial(");
    // The call row is attributed to the proven identity.
    expect(DIAL_ROUTE).toContain("placedBy: callerUserId");
    expect(DIAL_ROUTE).not.toContain("placedBy: userId");
  });

  it("screens EVERY target against the DNC list and the lead's dnc stage", () => {
    const dncCheck = DIAL_ROUTE.indexOf('supabase.rpc("is_phone_on_dnc"');
    expect(dncCheck).toBeGreaterThan(-1);
    // No longer gated on the owner target.
    const before = DIAL_ROUTE.slice(Math.max(0, dncCheck - 200), dncCheck);
    expect(before).not.toContain('dialTarget === "owner"');
    expect(DIAL_ROUTE).toContain('lead.status === "dnc"');
  });

  it("resolves the caller ID through the pool, scoped to the caller", () => {
    expect(HUMAN_CALL).toContain("selectPoolNumber(");
    expect(HUMAN_CALL).toContain("rankHumanCallCampaigns(");
    expect(DIAL_ROUTE).toContain("isAdmin: decision.isAdmin");
  });
});

describe("voice-browser-dial/complete route", () => {
  it("correlates by CallSid only — no 'most recent in-flight call' fallback", () => {
    expect(COMPLETE_ROUTE).toContain('.eq("twilio_call_sid", callSid)');
    expect(COMPLETE_ROUTE).not.toMatch(/\.in\("status",\s*\["queued"/);
    expect(COMPLETE_ROUTE).not.toContain('.order("created_at"');
  });
});

describe("dispositionHumanCall", () => {
  it("checks the lead is visible to the caller under RLS before using the service client", () => {
    const rlsCheck = DISPOSITION.indexOf('authed\n    .from("leads")');
    const serviceClient = DISPOSITION.indexOf("createAdminClient()");
    expect(rlsCheck).toBeGreaterThan(-1);
    expect(rlsCheck).toBeLessThan(serviceClient);
  });

  it("only touches calls the caller placed, pinned by CallSid when known", () => {
    expect(DISPOSITION).toContain('.eq("placed_by", user.id)');
    expect(DISPOSITION).toContain('.eq("twilio_call_sid", callSid)');
  });

  it("syncs the lead counters and last_call_at after the outcome is final", () => {
    const sideEffects = DISPOSITION.indexOf("applyOutcomeSideEffects(supabase");
    const sync = DISPOSITION.indexOf("syncLeadCallCounters(supabase");
    expect(sync).toBeGreaterThan(sideEffects);
    expect(DISPOSITION).toContain("last_call_at");
  });
});

describe("createHumanCallRow", () => {
  it("bumps last_call_at and recomputes the counters like every dial path", () => {
    const create = HUMAN_CALL.slice(
      HUMAN_CALL.indexOf("export async function createHumanCallRow"),
    );
    expect(create).toContain("last_call_at: startedAt");
    expect(create).toContain("syncLeadCallCounters(supabase, input.leadId)");
  });
});

describe("deactivating a user", () => {
  it("revokes their API keys as well as banning the login", () => {
    const deactivate = USER_ACTIONS.slice(
      USER_ACTIONS.indexOf("export async function setUserActive"),
      USER_ACTIONS.indexOf("export async function deleteUser"),
    );
    expect(deactivate).toContain("ban_duration");
    expect(deactivate).toContain('.from("api_keys")');
    expect(deactivate).toContain("revoked_at: new Date().toISOString()");
    expect(deactivate).toContain('.is("revoked_at", null)');
  });

  it("is enforced on every app page render via profiles.active", () => {
    expect(APP_LAYOUT).toMatch(/select\(\s*"[^"]*\bactive\b[^"]*"/);
    expect(APP_LAYOUT).toContain("profile.active === false");
    expect(APP_LAYOUT).toContain(
      'redirect("/auth/signout?reason=deactivated")',
    );
  });
});
