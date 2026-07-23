import { describe, expect, it } from "vitest";

import { pickSendingAccount } from "../src/lib/close/api";

describe("pickSendingAccount — only an account Close can actually send from", () => {
  const sendable = {
    id: "emailacct_ok",
    email: "marie@referrizer.com",
    send_status: "ok",
    enabled_features: ["email_syncing", "email_sending", "calendar_syncing"],
  };

  it("picks a send-capable account", () => {
    expect(pickSendingAccount([sendable])).toEqual({
      id: "emailacct_ok",
      email: "marie@referrizer.com",
    });
  });

  it("skips a sync-only account (no email_sending) — the bug we hit", () => {
    // A Gmail connected for reading only: it has an email and looks fine, but
    // Close rejects the send. Must NOT be chosen.
    expect(
      pickSendingAccount([
        {
          id: "emailacct_synconly",
          email: "marie@referrizer.com",
          send_status: "ok",
          enabled_features: ["email_syncing", "calendar_syncing"],
        },
      ]),
    ).toBeNull();
  });

  it("skips an account still initializing (send_status not ok)", () => {
    expect(
      pickSendingAccount([{ ...sendable, send_status: "initial" }]),
    ).toBeNull();
  });

  it("skips accounts with no email address (e.g. a Zoom connection)", () => {
    expect(
      pickSendingAccount([
        { id: "emailacct_zoom", enabled_features: [], send_status: undefined },
      ]),
    ).toBeNull();
  });

  it("returns null when nothing is connected", () => {
    expect(pickSendingAccount([])).toBeNull();
  });

  it("finds the sendable account among several", () => {
    const result = pickSendingAccount([
      { id: "emailacct_zoom", enabled_features: [] },
      {
        id: "emailacct_synconly",
        email: "old@x.com",
        send_status: "ok",
        enabled_features: ["email_syncing"],
      },
      sendable,
    ]);
    expect(result).toEqual({
      id: "emailacct_ok",
      email: "marie@referrizer.com",
    });
  });
});
