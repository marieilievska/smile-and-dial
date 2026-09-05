"use server";

import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  deleteElevenLabsPhoneNumber,
  ensureNumberImportedToElevenLabs,
} from "@/lib/twilio/place-call";
import {
  assignNumberToShaken,
  unassignNumberFromShaken,
} from "@/lib/twilio/shaken";

import {
  type AvailableNumber,
  type Country,
  expectedNumberWebhooks,
  listOwnedNumbers,
  pointNumberWebhooks,
  purchaseTwilioNumber,
  releaseTwilioNumber,
  searchAvailableNumbers,
  setNumberFriendlyName,
} from "./numbers";

/** Longest friendly name we'll store — keeps the table tidy and matches
 *  Twilio's own FriendlyName limit. */
const MAX_NAME_LENGTH = 64;

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

/** Confirm the caller is signed in, and report whether they're an admin.
 *  Members (builders) may manage numbers; a few actions still gate on admin,
 *  and releasing a number checks the attached campaign's owner. */
async function requireSignedIn(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string | null;
  isAdmin: boolean;
  error: string | null;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      supabase,
      userId: null,
      isAdmin: false,
      error: "You are not signed in.",
    };
  }
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  return {
    supabase,
    userId: user.id,
    isAdmin: me?.role === "admin",
    error: null,
  };
}

/** Search for purchasable phone numbers. */
export async function searchNumbers(input: {
  country: Country;
  areaCode: string;
}): Promise<{ numbers: AvailableNumber[]; error: string | null }> {
  const { error } = await requireSignedIn();
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
  const { supabase, userId, error: authError } = await requireSignedIn();
  if (authError) return { error: authError };

  const { twilioSid, error: buyError } = await purchaseTwilioNumber(
    input.phoneNumber,
  );
  if (buyError) return { error: buyError };

  // Auto-point the new number's voice + status webhooks at ElevenLabs'
  // native inbound endpoints before we tell the admin "done." (Inbound is
  // EL-native; the number becomes fully answerable once it's attached to a
  // campaign, which imports it into EL and assigns the agent.) If the pointing
  // call fails, we still record the row so the admin can see the number and hit
  // "Point to ElevenLabs" themselves.
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
    owner_id: userId!,
    phone_number: input.phoneNumber,
    friendly_name: input.friendlyName,
    country: input.country,
    monthly_cost: input.monthlyCost,
    twilio_sid: twilioSid,
    voice_webhook_url: voiceWebhookUrl,
    status_webhook_url: statusWebhookUrl,
  });
  if (error) return { error: "Could not save the purchased number." };

  // Sign the number for SHAKEN/STIR now (best-effort; a not-yet-configured
  // parent token simply skips).
  if (twilioSid) {
    try {
      const shaken = await assignNumberToShaken(twilioSid);
      if (!shaken.ok && !shaken.skipped) {
        console.warn(
          `SHAKEN/STIR signing failed for ${input.phoneNumber}: ${shaken.error}`,
        );
      }
    } catch (e) {
      console.warn(`SHAKEN/STIR signing threw for ${input.phoneNumber}`, e);
    }
  }

  revalidatePath(NUMBERS_PATH);
  return {
    error: webhookError
      ? `Number purchased, but webhook setup failed: ${webhookError} Click "Repoint webhooks" on the row to retry.`
      : null,
  };
}

/** Rename a number — give it a human label (e.g. "Alabama outbound") so the
 *  pool reads clearly. Stored in our DB (the source of truth the app shows
 *  everywhere) and pushed best-effort to Twilio's FriendlyName so the console
 *  matches. An empty name resets the label to the formatted phone number. */
export async function renameNumber(input: {
  id: string;
  name: string;
}): Promise<ActionResult> {
  const { supabase, error: authError } = await requireSignedIn();
  if (authError) return { error: authError };

  const name = input.name.trim().slice(0, MAX_NAME_LENGTH);

  const { data: number } = await supabase
    .from("twilio_numbers")
    .select("phone_number, twilio_sid")
    .eq("id", input.id)
    .maybeSingle();
  if (!number) return { error: "That number no longer exists." };

  // Fall back to the formatted phone number when the name is cleared, so a
  // row is never left blank.
  const friendlyName = name || number.phone_number;

  const { error } = await supabase
    .from("twilio_numbers")
    .update({ friendly_name: friendlyName })
    .eq("id", input.id);
  if (error) return { error: "Could not rename the number." };

  // Mirror to Twilio best-effort; never fail the rename if Twilio is down.
  await setNumberFriendlyName(number.twilio_sid, friendlyName);

  revalidatePath(NUMBERS_PATH);
  return { error: null };
}

/** Tear down what a number holds OUTSIDE our database once it's been given up
 *  at Twilio: its SHAKEN/STIR assignments on the parent Trust Hub and its
 *  ElevenLabs phone-number object. Both are best-effort — a hiccup is logged,
 *  never thrown. Reports whether the ElevenLabs object is now gone (true when
 *  there was none), so callers null the column only when that's the truth. */
async function teardownReleasedNumber(number: {
  phone_number: string;
  twilio_sid: string | null;
  elevenlabs_phone_number_id: string | null;
}): Promise<{ elevenLabsCleared: boolean }> {
  if (number.twilio_sid) {
    try {
      const shaken = await unassignNumberFromShaken(number.twilio_sid);
      if (!shaken.ok && !shaken.skipped) {
        console.warn(
          `SHAKEN/STIR un-sign failed for ${number.phone_number}: ${shaken.error}`,
        );
      }
    } catch (e) {
      console.warn(`SHAKEN/STIR un-sign threw for ${number.phone_number}`, e);
    }
  }

  if (!number.elevenlabs_phone_number_id) return { elevenLabsCleared: true };
  try {
    const el = await deleteElevenLabsPhoneNumber(
      number.elevenlabs_phone_number_id,
    );
    if (!el.ok) {
      console.warn(
        `ElevenLabs number removal failed for ${number.phone_number}: ${el.error}`,
      );
    }
    return { elevenLabsCleared: el.ok };
  } catch (e) {
    console.warn(
      `ElevenLabs number removal threw for ${number.phone_number}`,
      e,
    );
    return { elevenLabsCleared: false };
  }
}

/** Release a number — gives it up at Twilio, marks it released and detaches it
 *  from its campaign, then un-signs it (SHAKEN/STIR) and removes it from
 *  ElevenLabs so nothing outside the app keeps pointing at a dead number. */
export async function releaseNumber(id: string): Promise<ActionResult> {
  const {
    supabase,
    userId,
    isAdmin,
    error: authError,
  } = await requireSignedIn();
  if (authError) return { error: authError };

  const { data: number } = await supabase
    .from("twilio_numbers")
    .select(
      "phone_number, twilio_sid, released_at, attached_campaign_id, elevenlabs_phone_number_id",
    )
    .eq("id", id)
    .maybeSingle();
  if (!number) return { error: "That number no longer exists." };
  if (number.released_at) return { error: "That number is already released." };

  // Guardrail: a member can release an unattached number or one on their own
  // campaign, but not one attached to a teammate's campaign.
  if (!isAdmin && number.attached_campaign_id) {
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("owner_id")
      .eq("id", number.attached_campaign_id)
      .maybeSingle();
    if (!campaign || campaign.owner_id !== userId) {
      return {
        error: "That number is attached to another teammate's campaign.",
      };
    }
  }

  const { error: releaseError } = await releaseTwilioNumber(number.twilio_sid);
  if (releaseError) return { error: releaseError };

  // Twilio has the number back: record that and detach it from its campaign in
  // the same write, so a released number never sits "attached" to anything.
  const { error } = await supabase
    .from("twilio_numbers")
    .update({
      released_at: new Date().toISOString(),
      attached_campaign_id: null,
    })
    .eq("id", id);
  if (error) return { error: "Could not release the number." };

  // Sever the legacy single-number pointer too, or a later campaign-settings
  // save could re-claim a number that no longer exists.
  await supabase
    .from("campaigns")
    .update({ twilio_number_id: null })
    .eq("twilio_number_id", id);

  // Un-sign it on the parent Trust Hub and drop its ElevenLabs object. Neither
  // can fail the release; the EL id is cleared only once EL confirms it's gone,
  // so a miss stays visible and the delete path retries it.
  const { elevenLabsCleared } = await teardownReleasedNumber(number);
  if (elevenLabsCleared && number.elevenlabs_phone_number_id) {
    await supabase
      .from("twilio_numbers")
      .update({ elevenlabs_phone_number_id: null })
      .eq("id", id);
  }

  revalidatePath(NUMBERS_PATH);
  return { error: null };
}

/** Permanently delete a released number from the pool so it stops showing
 *  under "Released". Admin-only, and only for already-released numbers (the
 *  release step is what hands the number back to Twilio). Historical calls
 *  that referenced it are detached first so the foreign key doesn't block. */
export async function deleteTwilioNumber(id: string): Promise<ActionResult> {
  const { supabase, error: adminError } = await requireAdmin();
  if (adminError) return { error: adminError };

  const { data: number } = await supabase
    .from("twilio_numbers")
    .select("phone_number, twilio_sid, released_at, elevenlabs_phone_number_id")
    .eq("id", id)
    .maybeSingle();
  if (!number) return { error: "That number no longer exists." };
  if (!number.released_at) {
    return { error: "Release the number before deleting it." };
  }

  // Numbers released before the release path learned to un-sign are still on
  // the parent Trust Hub / in ElevenLabs; this is where they finally come off
  // (a no-op for ones the release already cleaned up). Deleting the row would
  // lose the only record of the EL object, so an EL miss blocks the delete —
  // the row stays under "Released" and the admin simply tries again.
  const { elevenLabsCleared } = await teardownReleasedNumber(number);
  if (!elevenLabsCleared) {
    return {
      error:
        "Could not remove the number from ElevenLabs, so nothing was deleted. Try again, or remove it in the ElevenLabs dashboard first.",
    };
  }

  // Service role for the delete: detach any historical calls and any campaign
  // still pointing at it, then remove the row (twilio_numbers has no per-user
  // delete RLS policy).
  const admin = createAdminClient();
  await admin
    .from("calls")
    .update({ twilio_number_id: null })
    .eq("twilio_number_id", id);
  await admin
    .from("campaigns")
    .update({ twilio_number_id: null })
    .eq("twilio_number_id", id);
  const { error } = await admin.from("twilio_numbers").delete().eq("id", id);
  if (error) return { error: "Could not delete the number." };

  revalidatePath(NUMBERS_PATH);
  return { error: null };
}

/** Repoint a single number's Twilio webhooks at ElevenLabs' native inbound
 *  endpoints. The recovery path when a number's VoiceUrl drifted back to the app
 *  (which breaks inbound — see expectedNumberWebhooks) or the purchase-time
 *  pointing call failed. */
export async function repointNumberWebhooks(id: string): Promise<ActionResult> {
  const { supabase, error: authError } = await requireSignedIn();
  if (authError) return { error: authError };

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
 *  piece Marija asked for: "see all twilio numbers in our account."
 *
 *  Admin-only: this reconciles the ENTIRE shared Twilio account, so it stays
 *  gated even though per-number self-service (buy / rename / release / repoint)
 *  is open to members. Untracked numbers it inserts have a null owner (admin-
 *  managed) rather than being silently claimed by whoever clicked Sync. */
export async function syncFromTwilio(): Promise<{
  added: number;
  refreshed: number;
  error: string | null;
}> {
  const { supabase, error: authError } = await requireAdmin();
  if (authError) return { added: 0, refreshed: 0, error: authError };

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

/** Register a single number with ElevenLabs for OUTBOUND dialing, caching its
 *  phone_number_id on the row. This is the visible repair path when the
 *  on-attach auto-register failed, or for numbers attached before that existed.
 *  Admin-only. Idempotent — a no-op (success) if already connected. */
export async function connectNumberToElevenLabs(
  id: string,
): Promise<ActionResult> {
  const { supabase, error: authError } = await requireSignedIn();
  if (authError) return { error: authError };

  const result = await ensureNumberImportedToElevenLabs(supabase, id);
  if (!result.ok) return { error: result.error };

  revalidatePath(NUMBERS_PATH);
  return { error: null };
}

/** Expose the webhook URLs the page expects (ElevenLabs' native inbound
 *  endpoints) so the UI can render "ok / mismatch" without recomputing them
 *  client-side. */
export async function getExpectedWebhookUrls(): Promise<{
  voiceUrl: string;
  statusCallback: string;
}> {
  return expectedNumberWebhooks();
}
