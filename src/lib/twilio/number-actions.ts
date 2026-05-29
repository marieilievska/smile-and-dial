"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

import {
  type AvailableNumber,
  type Country,
  appWebhookUrls,
  listOwnedNumbers,
  pointNumberWebhooks,
  purchaseTwilioNumber,
  releaseTwilioNumber,
  searchAvailableNumbers,
} from "./numbers";

const NUMBERS_PATH = "/settings/twilio-numbers";

type ActionResult = { error: string | null };

/** Confirm the caller is an admin — Twilio numbers are admin-managed. */
async function requireAdmin(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  error: string | null;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, error: "You are not signed in." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return { supabase, error: "Only admins can manage Twilio numbers." };
  }
  return { supabase, error: null };
}

/** Search for purchasable phone numbers. */
export async function searchNumbers(input: {
  country: Country;
  areaCode: string;
}): Promise<{ numbers: AvailableNumber[]; error: string | null }> {
  const { error } = await requireAdmin();
  if (error) return { numbers: [], error };
  return searchAvailableNumbers(input.country, input.areaCode);
}

/** Buy a phone number, immediately point its webhooks at this
 *  deployment, and record everything in the workspace pool. The
 *  webhook-point step is best-effort: if it fails Twilio still owns
 *  the number, the row still lands in the DB, and the admin sees a
 *  partial-success error so they can hit the "Repoint webhooks"
 *  button to retry. Without that, a transient Twilio API hiccup
 *  during the second call would orphan a number that we already
 *  paid for. */
export async function purchaseNumber(input: {
  phoneNumber: string;
  friendlyName: string;
  country: Country;
  monthlyCost: number;
}): Promise<ActionResult> {
  const { supabase, error: adminError } = await requireAdmin();
  if (adminError) return { error: adminError };

  const { twilioSid, error: buyError } = await purchaseTwilioNumber(
    input.phoneNumber,
  );
  if (buyError) return { error: buyError };

  // Round L2 — auto-point the new number's voice + status webhooks
  // at this deployment before we tell the admin "done." If the
  // pointing call fails, we still want to record the row so the
  // admin can see the number and hit "Repoint" themselves.
  let voiceWebhookUrl: string | null = null;
  let statusWebhookUrl: string | null = null;
  let webhookError: string | null = null;
  if (twilioSid) {
    const result = await pointNumberWebhooks(twilioSid);
    voiceWebhookUrl = result.voiceUrl;
    statusWebhookUrl = result.statusCallback;
    webhookError = result.error;
  }

  const { error } = await supabase.from("twilio_numbers").insert({
    phone_number: input.phoneNumber,
    friendly_name: input.friendlyName,
    country: input.country,
    monthly_cost: input.monthlyCost,
    twilio_sid: twilioSid,
    voice_webhook_url: voiceWebhookUrl,
    status_webhook_url: statusWebhookUrl,
  });
  if (error) return { error: "Could not save the purchased number." };

  revalidatePath(NUMBERS_PATH);
  return {
    error: webhookError
      ? `Number purchased, but webhook setup failed: ${webhookError} Click "Repoint webhooks" on the row to retry.`
      : null,
  };
}

/** Release a number — gives it up at Twilio and marks it released. */
export async function releaseNumber(id: string): Promise<ActionResult> {
  const { supabase, error: adminError } = await requireAdmin();
  if (adminError) return { error: adminError };

  const { data: number } = await supabase
    .from("twilio_numbers")
    .select("twilio_sid, released_at")
    .eq("id", id)
    .maybeSingle();
  if (!number) return { error: "That number no longer exists." };
  if (number.released_at) return { error: "That number is already released." };

  const { error: releaseError } = await releaseTwilioNumber(number.twilio_sid);
  if (releaseError) return { error: releaseError };

  const { error } = await supabase
    .from("twilio_numbers")
    .update({ released_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { error: "Could not release the number." };

  revalidatePath(NUMBERS_PATH);
  return { error: null };
}

/** Round L2 — repoint a single number's webhooks at this deployment.
 *  Used when the deployment URL changes (custom domain, preview
 *  promote) or when the purchase-time pointing call failed. */
export async function repointNumberWebhooks(id: string): Promise<ActionResult> {
  const { supabase, error: adminError } = await requireAdmin();
  if (adminError) return { error: adminError };

  const { data: number } = await supabase
    .from("twilio_numbers")
    .select("twilio_sid, released_at")
    .eq("id", id)
    .maybeSingle();
  if (!number) return { error: "That number no longer exists." };
  if (!number.twilio_sid) return { error: "No Twilio SID on file." };
  if (number.released_at) return { error: "That number has been released." };

  const result = await pointNumberWebhooks(number.twilio_sid);
  if (result.error) return { error: result.error };

  const { error } = await supabase
    .from("twilio_numbers")
    .update({
      voice_webhook_url: result.voiceUrl,
      status_webhook_url: result.statusCallback,
    })
    .eq("id", id);
  if (error) return { error: "Could not update the stored webhook URLs." };

  revalidatePath(NUMBERS_PATH);
  return { error: null };
}

/** Round L2 — pull every IncomingPhoneNumber from the Twilio account
 *  and reconcile with our database. For numbers we already track,
 *  refresh the recorded webhook URLs so the page can flag drift
 *  ("Twilio is set to point at someone else"). For numbers we don't
 *  track, INSERT them so they're visible in the admin pool with the
 *  webhook columns populated from Twilio. This is the visibility
 *  piece Marija asked for: "see all twilio numbers in our account." */
export async function syncFromTwilio(): Promise<{
  added: number;
  refreshed: number;
  error: string | null;
}> {
  const { supabase, error: adminError } = await requireAdmin();
  if (adminError) return { added: 0, refreshed: 0, error: adminError };

  const { numbers, error: listError } = await listOwnedNumbers();
  if (listError) return { added: 0, refreshed: 0, error: listError };

  // Pull every twilio_sid we already have so we know which numbers
  // are new vs. already tracked. We don't filter by released_at —
  // a number released here but still owned at Twilio (rare, but
  // possible if the release call failed) should still get refreshed.
  const { data: existing } = await supabase
    .from("twilio_numbers")
    .select("id, twilio_sid, phone_number");
  const bySid = new Map<string, { id: string; phone_number: string }>();
  for (const row of existing ?? []) {
    if (row.twilio_sid) {
      bySid.set(row.twilio_sid, { id: row.id, phone_number: row.phone_number });
    }
  }

  let added = 0;
  let refreshed = 0;
  for (const n of numbers) {
    const existingRow = bySid.get(n.twilioSid);
    if (existingRow) {
      const { error } = await supabase
        .from("twilio_numbers")
        .update({
          voice_webhook_url: n.voiceUrl,
          status_webhook_url: n.statusCallback,
        })
        .eq("id", existingRow.id);
      if (!error) refreshed++;
    } else {
      // Country code — Twilio doesn't return it on the list endpoint
      // in a useful way, so we infer from the phone-number prefix.
      // +1XXXXXXXXXX is the only allowlist today; anything else is
      // a country mismatch that we'll surface as "US" by default
      // since the column is NOT NULL. The admin can edit later.
      const country: Country = n.phoneNumber.startsWith("+1") ? "US" : "US";
      const { error } = await supabase.from("twilio_numbers").insert({
        phone_number: n.phoneNumber,
        friendly_name: n.friendlyName,
        country,
        monthly_cost: 0,
        twilio_sid: n.twilioSid,
        voice_webhook_url: n.voiceUrl,
        status_webhook_url: n.statusCallback,
      });
      if (!error) added++;
    }
  }

  revalidatePath(NUMBERS_PATH);
  return { added, refreshed, error: null };
}

/** Expose the webhook URLs the page expects so the UI can render
 *  "ok / mismatch" without recomputing them client-side. Returns
 *  null when the env var isn't set so the page can show a hint. */
export async function getExpectedWebhookUrls(): Promise<{
  voiceUrl: string;
  statusCallback: string;
} | null> {
  return appWebhookUrls();
}
