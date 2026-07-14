# Email → Live (send through Close) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI's in-call `send_email` tool actually deliver through Close (instead of writing a fake "sent" row), and never claim it sent when it couldn't.

**Architecture:** Extract the real Close delivery (already written but dormant in `close/actions.ts`) into one shared helper. Split the "what should happen" decision into a pure, unit-tested function (`planEmailSend`) separate from the I/O. The in-call tool delivers for real only when the EL integration is live **and** the lead owner has a connected Close account; otherwise it records the intent honestly without a fake send. Real delivery is gated on `ELEVENLABS_LIVE === "live"` (reliably set in prod, unset in tests) so the test env never touches Close.

**Tech Stack:** Next.js (App Router), TypeScript, Supabase (service role), Close REST API, Playwright (contract tests).

**Spec:** [docs/superpowers/specs/2026-07-14-close-texting-and-live-email-design.md](../specs/2026-07-14-close-texting-and-live-email-design.md) — this plan is **Phase 1** only.

---

## File structure

- **Create** `src/lib/close/email-send-plan.ts` — pure decision function (`planEmailSend`) + types. **No `server-only`** so it's unit-testable.
- **Create** `src/lib/close/send-email.ts` — `deliverEmailViaClose()`, the server-only Close I/O (sender lookup → find/create contact → outbox send).
- **Modify** `src/lib/close/actions.ts` — the dormant `sendEmail()` server action uses the new helper (DRY); trim now-unused imports.
- **Modify** `src/lib/elevenlabs/tool-webhook.ts` — rewrite the in-call `sendEmail()` handler to use `planEmailSend` + `deliverEmailViaClose`, add a local `recordSentEmail()` helper.
- **Create** `tests/send-email-plan.spec.ts` — pure matrix test for `planEmailSend`.

---

### Task 0: Create the feature branch (commit nothing to `main`)

**Files:** none (git only)

- [ ] **Step 1: Branch**

```bash
git checkout -b feat/email-live-close
```

- [ ] **Step 2: Commit the spec + this plan onto the branch**

```bash
git add docs/superpowers/specs/2026-07-14-close-texting-and-live-email-design.md docs/superpowers/plans/2026-07-14-email-live-close.md
git commit -m "docs: Close texting + live email design/plan"
```

---

### Task 1: Extract the Close delivery helper

**Files:**

- Create: `src/lib/close/send-email.ts`
- Modify: `src/lib/close/actions.ts` (lines ~10-21 imports; ~169-224 send block)

- [ ] **Step 1: Create the helper**

`src/lib/close/send-email.ts`:

```ts
import "server-only";

import {
  closeSenderEmail,
  createCloseLead,
  findCloseLeadByEmail,
  sendCloseEmail,
} from "./api";

export type DeliverEmailInput = {
  closeKey: string;
  senderName: string | null;
  toAddress: string;
  subject: string;
  body: string;
  contactName: string | null;
  company: string | null;
  businessPhone: string | null;
};

export type DeliverEmailResult =
  | { ok: true; closeMessageId: string; fromAddress: string }
  | { ok: false; error: string };

/** Deliver one email through the owner's Close account: resolve the sending
 *  address, find-or-create the Close contact, then post an outbox email that
 *  Close delivers. Never throws — returns {ok:false, error} so callers can be
 *  honest instead of recording a false "sent". The caller owns template
 *  rendering, the owner-key lookup, and writing the `emails` row. */
export async function deliverEmailViaClose(
  input: DeliverEmailInput,
): Promise<DeliverEmailResult> {
  const senderEmail = await closeSenderEmail(input.closeKey);
  if (!senderEmail) return { ok: false, error: "no_connected_sending_email" };

  const fromAddress = input.senderName
    ? `${input.senderName} <${senderEmail}>`
    : senderEmail;

  let ref = await findCloseLeadByEmail(input.closeKey, input.toAddress);
  if (!ref) {
    ref = await createCloseLead(input.closeKey, {
      companyName: input.company,
      contactName: input.contactName,
      email: input.toAddress,
      phone: input.businessPhone,
    });
  }
  if (!ref) return { ok: false, error: "could_not_create_contact" };

  const sent = await sendCloseEmail(input.closeKey, {
    leadId: ref.leadId,
    contactId: ref.contactId,
    to: input.toAddress,
    subject: input.subject,
    bodyText: input.body,
    sender: fromAddress,
  });
  if (sent.error || !sent.id) {
    return { ok: false, error: sent.error ?? "close_send_failed" };
  }
  return { ok: true, closeMessageId: sent.id, fromAddress };
}
```

- [ ] **Step 2: Refactor the dormant server action to use it**

In `src/lib/close/actions.ts`, replace the send block (the `let closeMessageId … } else { … }` around lines 169-224) with:

```ts
let closeMessageId: string;
let fromAddress: string;

if (closeKey) {
  const delivered = await deliverEmailViaClose({
    closeKey,
    senderName: ownerProfile?.full_name ?? null,
    toAddress,
    subject,
    body,
    contactName:
      (leadRecord.owner_name as string | null | undefined) ||
      (leadRecord.manager_name as string | null | undefined) ||
      null,
    company: (leadRecord.company as string | null | undefined) ?? null,
    businessPhone:
      (leadRecord.business_phone as string | null | undefined) ?? null,
  });
  if (!delivered.ok) {
    return {
      error:
        delivered.error === "no_connected_sending_email"
          ? "Your Close account has no connected email to send from. Connect an email account in Close, then try again."
          : `Couldn't send the email through Close. ${delivered.error}`.trim(),
    };
  }
  closeMessageId = delivered.closeMessageId;
  fromAddress = delivered.fromAddress;
} else {
  closeMessageId = `mock-msg-${Date.now()}`;
  fromAddress = ownerProfile?.full_name
    ? `${ownerProfile.full_name} via Close`
    : "Close mock";
}
```

Then fix imports at the top of `actions.ts`: add `import { deliverEmailViaClose } from "./send-email";`, and **remove** `closeSenderEmail` and `sendCloseEmail` from the `./api` import (now unused here — `findCloseLeadByEmail` and `createCloseLead` stay; `handoffLeadToClose` still uses them).

- [ ] **Step 3: Verify types + lint**

Run: `npx tsc --noEmit && npx eslint src/lib/close/send-email.ts src/lib/close/actions.ts`
Expected: no errors. (Pure refactor — behavior of the server action is unchanged; it has no Close-free unit test, so the type/lint gate + Task 2's tests + the Task 6 prod smoke cover it.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/close/send-email.ts src/lib/close/actions.ts
git commit -m "refactor(close): extract deliverEmailViaClose helper"
```

---

### Task 2: Pure honesty-decision function (`planEmailSend`)

**Files:**

- Create: `src/lib/close/email-send-plan.ts`
- Test: `tests/send-email-plan.spec.ts`

- [ ] **Step 1: Write the failing test**

`tests/send-email-plan.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

import { planEmailSend } from "../src/lib/close/email-send-plan";

test.describe("planEmailSend — send_email honesty matrix", () => {
  test("non-live records a mock row and reports sent", () => {
    expect(
      planEmailSend({ live: false, hasCloseKey: false, delivered: null }),
    ).toEqual({ action: "record_mock" });
  });

  test("live without a Close connection notes only — never a fake sent", () => {
    expect(
      planEmailSend({ live: true, hasCloseKey: false, delivered: null }),
    ).toEqual({ action: "note_only", reason: "owner_close_not_connected" });
  });

  test("live + connected + delivered records the real send", () => {
    expect(
      planEmailSend({ live: true, hasCloseKey: true, delivered: { ok: true } }),
    ).toEqual({ action: "record_real" });
  });

  test("live + connected + delivery failed notes only with the reason", () => {
    expect(
      planEmailSend({
        live: true,
        hasCloseKey: true,
        delivered: { ok: false, error: "no_connected_sending_email" },
      }),
    ).toEqual({ action: "note_only", reason: "no_connected_sending_email" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx playwright test tests/send-email-plan.spec.ts`
Expected: FAIL — `planEmailSend` is not exported / module not found.

- [ ] **Step 3: Implement the pure function**

`src/lib/close/email-send-plan.ts` (no `server-only` — must stay importable by the test):

```ts
/** Decides what the in-call send_email tool should DO, kept pure so the honesty
 *  rules are unit-tested without touching Close or the database.
 *  - non-live (dev/test): record a mock row so the flow + activity feed work.
 *  - live + no Close connection: note the intent only — NEVER a fake "sent".
 *  - live + delivered: record the real send.
 *  - live + delivery failed: note only, keep the failure reason. */
export type EmailSendPlan =
  | { action: "record_mock" }
  | { action: "record_real" }
  | { action: "note_only"; reason: string };

export function planEmailSend(input: {
  live: boolean;
  hasCloseKey: boolean;
  delivered: { ok: boolean; error?: string } | null;
}): EmailSendPlan {
  if (!input.live) return { action: "record_mock" };
  if (!input.hasCloseKey) {
    return { action: "note_only", reason: "owner_close_not_connected" };
  }
  if (input.delivered?.ok) return { action: "record_real" };
  return {
    action: "note_only",
    reason: input.delivered?.error ?? "close_send_failed",
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx playwright test tests/send-email-plan.spec.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/close/email-send-plan.ts tests/send-email-plan.spec.ts
git commit -m "feat(close): pure planEmailSend honesty decision + tests"
```

---

### Task 3: Rewire the in-call `send_email` tool to deliver for real

**Files:**

- Modify: `src/lib/elevenlabs/tool-webhook.ts` (imports; `sendEmail()` ~lines 370-455; add `recordSentEmail()` helper)

- [ ] **Step 1: Add imports**

At the top of `tool-webhook.ts`, alongside the existing `@/lib/close/templates` import:

```ts
import { deliverEmailViaClose } from "@/lib/close/send-email";
import { planEmailSend } from "@/lib/close/email-send-plan";
```

- [ ] **Step 2: Add a local `recordSentEmail` helper**

Place it just above `async function sendEmail(` in `tool-webhook.ts`:

```ts
/** Insert the sent `emails` row + bump the template's last_used_at. Shared by
 *  the real-delivery and mock paths (they differ only in from/message id). */
async function recordSentEmail(
  ctx: CallContext,
  args: {
    templateId: string;
    subject: string;
    body: string;
    toAddress: string;
    fromAddress: string;
    closeMessageId: string;
  },
): Promise<string | null> {
  const { data: inserted } = await ctx.supabase
    .from("emails")
    .insert({
      lead_id: ctx.lead.id,
      owner_id: ctx.lead.owner_id,
      campaign_id: ctx.campaignId,
      call_id: ctx.callId,
      direction: "sent",
      subject: args.subject,
      body: args.body,
      to_address: args.toAddress,
      from_address: args.fromAddress,
      close_message_id: args.closeMessageId,
      status: "sent",
      template_id: args.templateId,
    })
    .select("id")
    .maybeSingle();
  await ctx.supabase
    .from("email_templates")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", args.templateId);
  return inserted?.id ?? null;
}
```

- [ ] **Step 3: Replace the body of `sendEmail(ctx, body)`**

Replace the function body from after `const renderedBody = renderTemplate(tmpl.body, renderCtx);` down to its final `return`. Keep everything above (email resolution, capture-onto-lead, no-template early return, context build, render) unchanged. New tail:

```ts
const live = process.env.ELEVENLABS_LIVE === "live";
const sentMessage = `Done — I've sent the "${tmpl.name}" email to ${email}. It should arrive shortly.`;
const notedMessage = `Got it — I've noted to send that to ${email}.`;

// In live mode, look up the owner's Close key and attempt real delivery.
let hasCloseKey = false;
let delivered: Awaited<ReturnType<typeof deliverEmailViaClose>> | null = null;
if (live) {
  const { data: integ } = await ctx.supabase
    .from("user_integrations")
    .select("close_api_key")
    .eq("user_id", ctx.lead.owner_id)
    .maybeSingle();
  const closeKey = integ?.close_api_key?.trim() || null;
  hasCloseKey = Boolean(closeKey);
  if (closeKey) {
    delivered = await deliverEmailViaClose({
      closeKey,
      senderName: renderCtx.owner?.full_name ?? null,
      toAddress: email,
      subject,
      body: renderedBody,
      contactName: ctx.lead.owner_name || ctx.lead.manager_name || null,
      company: ctx.lead.company,
      businessPhone: ctx.lead.business_phone,
    });
  }
}

const plan = planEmailSend({ live, hasCloseKey, delivered });

if (plan.action === "note_only") {
  await logToolEvent(ctx, "tool_send_email", {
    email,
    template_id: tmpl.id,
    sent: false,
    reason: plan.reason,
  });
  return { success: true, message: notedMessage };
}

const isReal = plan.action === "record_real";
const fromAddress =
  isReal && delivered?.ok
    ? delivered.fromAddress
    : renderCtx.owner?.full_name
      ? `${renderCtx.owner.full_name} via Close`
      : "Close mock";
const closeMessageId =
  isReal && delivered?.ok ? delivered.closeMessageId : `mock-msg-${Date.now()}`;

const emailId = await recordSentEmail(ctx, {
  templateId: tmpl.id,
  subject,
  body: renderedBody,
  toAddress: email,
  fromAddress,
  closeMessageId,
});

await logToolEvent(ctx, "tool_send_email", {
  email,
  template_id: tmpl.id,
  email_id: emailId,
  sent: true,
  mock: !isReal,
});

return { success: true, message: sentMessage };
```

- [ ] **Step 4: Update the stale mock comment**

Delete the old comment block that says _"Live Close delivery isn't built yet, so this is the mock path…"_ — it's no longer true.

- [ ] **Step 5: Verify types + lint**

Run: `npx tsc --noEmit && npx eslint src/lib/elevenlabs/tool-webhook.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/elevenlabs/tool-webhook.ts
git commit -m "feat(close): send_email delivers through Close in live mode (honest fallback)"
```

---

### Task 4: Full local verification gate

- [ ] **Step 1: Types, lint, build, pure tests**

Run:

```bash
npx tsc --noEmit
npx eslint src/lib/close src/lib/elevenlabs/tool-webhook.ts tests/send-email-plan.spec.ts
npm run build
npx playwright test tests/send-email-plan.spec.ts
```

Expected: all clean; 4 tests pass. Fix anything before shipping.

---

### Task 5: Ship (push → PR → merge)

Branch + docs commit already done in Task 0.

- [ ] **Step 1: Push + open PR**

```bash
git push -u origin feat/email-live-close
gh pr create --title "Email → live: send through Close (honest fallback)" --body "<clear description: what changed, the ELEVENLABS_LIVE gate, the honesty rule, and the prod verification done in Task 6>"
```

- [ ] **Step 4: Merge** to `main` (auto-deploys on Vercel).

---

### Task 6: Production verification (email is truly live)

> This is the real test of "live" — the harness can't reach Close, so we confirm delivery in prod deliberately and safely.

- [ ] **Step 1: Confirm the gate is set in prod.** Verify `ELEVENLABS_LIVE=live` is present in the Vercel production environment (it governs the whole tool webhook). If it's missing, real delivery silently stays mock — set it before testing.

- [ ] **Step 2: Confirm who has Close connected.** Query prod (service-role key in `.env.local` against PostgREST) for `user_integrations` rows with a non-null `close_api_key`, and for those owners confirm Close has a connected sending email. Report to Marija. Live delivery only works for owners on this list.

- [ ] **Step 3: Controlled real send.** For a lead owned by a Close-connected owner (use a lead whose `business_email` is **your own / Marija's** inbox, on a campaign that has an email template), trigger the `send_email` tool (a real test call, or a one-off invocation of the tool endpoint with that call_id). Confirm: the email actually arrives, and the new `emails` row has a **real** `close_message_id` (not `mock-…`).

- [ ] **Step 4: Confirm the honest path.** For an owner with **no** Close connection, confirm the tool logs `sent:false, reason:"owner_close_not_connected"` and writes **no** `emails` row — the AI said "noted," not "sent."

- [ ] **Step 5: Report results** to Marija (who's connected, that a real email landed, sample message id). Phase 1 done → Phase 2 (texting) can start.

---

## Self-review notes

- **Spec coverage:** Phase 1 items (wire to real delivery, honesty rule, no fake sent, one shared send path, no schema change, per-agent toggle unchanged) each map to a task above. Phase 2 is intentionally out of scope.
- **Gate choice:** real delivery is gated on `ELEVENLABS_LIVE` (reliably live in prod, unset in tests) rather than `CLOSE_LIVE` (only used for inbound signatures; prod value unverified). Task 6 Step 1 guards the "flag not set" failure mode.
- **Type consistency:** `deliverEmailViaClose`/`DeliverEmailResult` (Task 1) are consumed by `planEmailSend`'s `delivered` arg and the tool (Tasks 2-3); `record_mock`/`record_real`/`note_only` are the only actions and every one is handled in Task 3.
