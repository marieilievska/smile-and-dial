import { describe, expect, it } from "vitest";

import {
  parseCloseSmsNumbers,
  pickSmsFromNumber,
  smsCapableNumbers,
  type ClosePhoneNumberRecord,
  type CloseSmsNumber,
} from "../src/lib/close/sms-from-number";

/** Shapes lifted from Close's phone-number list
 *  (GET /api/v1/phone_number/): an internal SMS number owned by a user, an
 *  "external" caller-ID entry (the user's own cell — can't text), and a group
 *  number with no user_id. */
const ownInternal: ClosePhoneNumberRecord = {
  number: "+16503335555",
  number_formatted: "+1 650-333-5555",
  label: "Personal Number",
  user_id: "user_me",
  is_group_number: false,
  sms_enabled: true,
  type: "internal",
};
const teammateInternal: ClosePhoneNumberRecord = {
  number: "+16508881111",
  number_formatted: "+1 650-888-1111",
  label: "Personal Number",
  user_id: "user_teammate",
  is_group_number: false,
  sms_enabled: true,
  type: "internal",
};
const externalCell: ClosePhoneNumberRecord = {
  number: "+14151231234",
  number_formatted: "+1 415-123-1234",
  label: "My Personal Cell",
  user_id: "user_me",
  is_group_number: false,
  sms_enabled: false,
  type: "external",
};
const groupNumber: ClosePhoneNumberRecord = {
  number: "+16508881234",
  number_formatted: "+1 650-888-1234",
  label: "Group Number",
  user_id: null,
  is_group_number: true,
  sms_enabled: true,
  type: "internal",
};

describe("smsCapableNumbers — which Close numbers can text at all", () => {
  it("keeps sms_enabled internal numbers, in Close's order", () => {
    const out = smsCapableNumbers([teammateInternal, ownInternal, groupNumber]);
    expect(out.map((n) => n.number)).toEqual([
      "+16508881111",
      "+16503335555",
      "+16508881234",
    ]);
    expect(out[2]).toEqual({
      number: "+16508881234",
      formatted: "+1 650-888-1234",
      label: "Group Number",
      userId: null,
      isGroup: true,
    });
  });

  it("drops external caller-ID numbers and anything without SMS", () => {
    expect(
      smsCapableNumbers([
        externalCell,
        { ...ownInternal, sms_enabled: false },
        { ...ownInternal, number: "+16500000000", type: "virtual" },
        { ...ownInternal, number: "" },
      ]),
    ).toEqual([]);
  });

  it("dedupes a number Close lists twice", () => {
    expect(smsCapableNumbers([ownInternal, ownInternal])).toHaveLength(1);
  });
});

describe("pickSmsFromNumber — the number the agent texts from", () => {
  const numbers: CloseSmsNumber[] = smsCapableNumbers([
    teammateInternal,
    groupNumber,
    ownInternal,
  ]);

  it("prefers a number assigned to the connecting Close user", () => {
    expect(
      pickSmsFromNumber(numbers, { closeUserId: "user_me", current: null }),
    ).toBe("+16503335555");
  });

  it("falls back to the first SMS-capable number when the user owns none", () => {
    expect(
      pickSmsFromNumber(numbers, { closeUserId: "user_other", current: null }),
    ).toBe("+16508881111");
    expect(
      pickSmsFromNumber(numbers, { closeUserId: null, current: null }),
    ).toBe("+16508881111");
  });

  it("keeps the current choice when Close still lists it (a refresh never swaps a working number)", () => {
    expect(
      pickSmsFromNumber(numbers, {
        closeUserId: "user_me",
        current: "+16508881234",
      }),
    ).toBe("+16508881234");
  });

  it("re-picks when the current choice is no longer SMS-capable", () => {
    expect(
      pickSmsFromNumber(numbers, {
        closeUserId: "user_me",
        current: "+14151231234",
      }),
    ).toBe("+16503335555");
  });

  it("returns null for an empty list — the caller must be honest, not invent a number", () => {
    expect(
      pickSmsFromNumber([], { closeUserId: "user_me", current: null }),
    ).toBe(null);
    expect(
      pickSmsFromNumber([], {
        closeUserId: "user_me",
        current: "+16503335555",
      }),
    ).toBe(null);
  });
});

describe("parseCloseSmsNumbers — the stored jsonb back into the typed list", () => {
  it("round-trips what syncCloseSmsNumbers stores", () => {
    const stored = smsCapableNumbers([ownInternal, groupNumber]);
    expect(parseCloseSmsNumbers(JSON.parse(JSON.stringify(stored)))).toEqual(
      stored,
    );
  });

  it("tolerates null, non-arrays and malformed entries", () => {
    expect(parseCloseSmsNumbers(null)).toEqual([]);
    expect(parseCloseSmsNumbers("nope")).toEqual([]);
    expect(parseCloseSmsNumbers([{ label: "no number" }, 7, null])).toEqual([]);
    expect(parseCloseSmsNumbers([{ number: "+16503335555" }])).toEqual([
      {
        number: "+16503335555",
        formatted: "+16503335555",
        label: "",
        userId: null,
        isGroup: false,
      },
    ]);
  });
});
