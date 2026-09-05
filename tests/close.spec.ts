import { createHmac } from "node:crypto";

import { test, expect, request as playwrightRequest } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { renderTemplate } from "../src/lib/close/templates";

test.describe.configure({ mode: "serial" });

/**
 * Close email integration (Step 38 / BUILD_PLAN §12).
 *
 * Coverage:
 *  - renderTemplate substitutes the documented variables
 *  - Inbound webhook (Close's real `{ event: { object_type: "activity.email",
 *    action: "created", data } }` shape, signed with the per-user
 *    signature_key) matches a lead by sender address, writes a received
 *    emails row, flips lead.status to email_replied, and inserts a
 *    notification for the owner
 *  - A reply matched via in_reply_to_id attaches to the original thread
 *  - An unsigned delivery is rejected with 401
 */
test.describe("Close email integration", () => {
  test.use({ storageState: "playwright/.auth/user.json" });

  const stamp = Date.now();
  const tail = String(stamp).slice(-6);

  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let leadId: string;
  let sentEmailId: string;
  const closeReplyId = `close-reply-${stamp}`;
  const closeReplyId2 = `close-reply-thread-${stamp}`;

  // A signature_key as Close returns it (hex). Installed on the test user for
  // the run and restored afterwards so a real subscription isn't clobbered.
  const SIG_KEY =
    "058bfb6a3d8cfdc4da7c3be5901b16ae11da982b46a25fb2cd7016e97a140a1c";
  let previousSigKey: string | null = null;

  function signedHeaders(rawBody: string) {
    const t = String(Math.floor(Date.now() / 1000));
    const hash = createHmac("sha256", Buffer.from(SIG_KEY, "hex"))
      .update(t + rawBody)
      .digest("hex");
    return {
      "content-type": "application/json",
      "close-sig-timestamp": t,
      "close-sig-hash": hash,
    };
  }

  function emailCreated(data: Record<string, unknown>) {
    return JSON.stringify({
      event: {
        object_type: "activity.email",
        action: "created",
        object_id: data.id,
        lead_id: "lead_e2e",
        data,
      },
      subscription_id: "whsub_e2e",
    });
  }

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    ownerId = owner!.id;

    const { data: integ } = await admin
      .from("user_integrations")
      .select("close_webhook_signature_key")
      .eq("user_id", ownerId)
      .maybeSingle();
    previousSigKey = integ?.close_webhook_signature_key ?? null;
    await admin
      .from("user_integrations")
      .upsert(
        { user_id: ownerId, close_webhook_signature_key: SIG_KEY },
        { onConflict: "user_id" },
      );

    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Close List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Close Lead ${stamp}`,
        business_phone: `+1444${tail}10`,
        business_email: `e2e-close-${stamp}@example.com`,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadId = lead!.id;

    // Pretend we previously sent an email so the thread match has something
    // to grab onto in test 3.
    const { data: sent } = await admin
      .from("emails")
      .insert({
        lead_id: leadId,
        owner_id: ownerId,
        direction: "sent",
        subject: `Thread starter ${stamp}`,
        body: "Hi",
        to_address: `e2e-close-${stamp}@example.com`,
        from_address: "owner@smileanddial.test",
        close_message_id: `mock-sent-${stamp}`,
        status: "sent",
      })
      .select("id")
      .single();
    sentEmailId = sent!.id;
  });

  test.afterAll(async () => {
    await admin
      .from("emails")
      .delete()
      .in("close_message_id", [
        closeReplyId,
        closeReplyId2,
        `mock-sent-${stamp}`,
      ]);
    if (sentEmailId) await admin.from("emails").delete().eq("id", sentEmailId);
    await admin.from("notifications").delete().eq("ref_id", leadId);
    if (leadId) await admin.from("leads").delete().eq("id", leadId);
    if (listId) await admin.from("lists").delete().eq("id", listId);
    await admin
      .from("user_integrations")
      .update({ close_webhook_signature_key: previousSigKey })
      .eq("user_id", ownerId);
  });

  test("renderTemplate substitutes the documented variables", () => {
    const out = renderTemplate(
      "Hi {{lead.owner_name}} — {{campaign.name}} for {{lead.company}}",
      {
        lead: { owner_name: "Pat", company: "Acme" },
        campaign: { name: "Q1 Outbound" },
      },
    );
    expect(out).toBe("Hi Pat — Q1 Outbound for Acme");
  });

  test("an unsigned delivery is rejected", async ({ baseURL }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const raw = emailCreated({
      id: `close-forged-${stamp}`,
      direction: "incoming",
      sender: `e2e-close-${stamp}@example.com`,
    });
    const r = await api.post(`/api/close/webhook?u=${ownerId}`, {
      data: raw,
      headers: { "content-type": "application/json" },
    });
    expect(r.status()).toBe(401);
  });

  test("inbound activity.email created (incoming) matches by sender and flips status", async ({
    baseURL,
  }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const raw = emailCreated({
      id: closeReplyId,
      direction: "incoming",
      sender: `E2E Lead <e2e-close-${stamp}@example.com>`,
      to: ["owner@smileanddial.test"],
      subject: "Re: Thread starter",
      body_text: "Sounds good!",
      date_created: new Date().toISOString(),
    });
    const r = await api.post(`/api/close/webhook?u=${ownerId}`, {
      data: raw,
      headers: signedHeaders(raw),
    });
    expect(r.status()).toBe(200);

    const { data: lead } = await admin
      .from("leads")
      .select("status")
      .eq("id", leadId)
      .single();
    expect(lead?.status).toBe("email_replied");

    const { data: email } = await admin
      .from("emails")
      .select("direction, lead_id, status")
      .eq("close_message_id", closeReplyId)
      .single();
    expect(email?.direction).toBe("received");
    expect(email?.status).toBe("received");
    expect(email?.lead_id).toBe(leadId);

    const { data: notifs } = await admin
      .from("notifications")
      .select("kind, message")
      .eq("ref_id", leadId)
      .eq("kind", "email_replied");
    expect((notifs ?? []).length).toBeGreaterThan(0);
  });

  test("reply with in_reply_to_id attaches to the original thread", async ({
    baseURL,
  }) => {
    const api = await playwrightRequest.newContext({ baseURL });
    const raw = emailCreated({
      id: closeReplyId2,
      direction: "incoming",
      sender: `someone-else-${stamp}@example.com`,
      subject: "Re: Thread starter",
      in_reply_to_id: `mock-sent-${stamp}`,
      body_text: "Following up.",
    });
    const r = await api.post(`/api/close/webhook?u=${ownerId}`, {
      data: raw,
      headers: signedHeaders(raw),
    });
    expect(r.status()).toBe(200);

    const { data: email } = await admin
      .from("emails")
      .select("lead_id, direction")
      .eq("close_message_id", closeReplyId2)
      .single();
    expect(email?.lead_id).toBe(leadId);
    expect(email?.direction).toBe("received");
  });
});
