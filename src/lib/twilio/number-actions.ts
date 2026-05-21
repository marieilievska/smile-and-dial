"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

import {
  type AvailableNumber,
  type Country,
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

/** Buy a phone number and record it in the workspace pool. */
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

  const { error } = await supabase.from("twilio_numbers").insert({
    phone_number: input.phoneNumber,
    friendly_name: input.friendlyName,
    country: input.country,
    monthly_cost: input.monthlyCost,
    twilio_sid: twilioSid,
  });
  if (error) return { error: "Could not save the purchased number." };

  revalidatePath(NUMBERS_PATH);
  return { error: null };
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
