"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type IntegrationResult = { error: string | null };

/**
 * Save the ElevenLabs API key and allowed voice IDs. An empty `apiKey`
 * leaves the stored key unchanged, so the secret never has to be re-typed.
 */
export async function updateElevenLabsSettings(input: {
  apiKey: string;
  voiceIds: string;
}): Promise<IntegrationResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return { error: "Only admins can change integrations." };
  }

  const update: {
    elevenlabs_voice_ids: string | null;
    elevenlabs_api_key?: string;
    updated_at: string;
  } = {
    elevenlabs_voice_ids: input.voiceIds.trim() || null,
    updated_at: new Date().toISOString(),
  };
  const trimmedKey = input.apiKey.trim();
  if (trimmedKey) update.elevenlabs_api_key = trimmedKey;

  const { error } = await supabase
    .from("app_settings")
    .update(update)
    .eq("id", 1);
  if (error) return { error: "Could not save the settings." };

  revalidatePath("/settings/integrations");
  return { error: null };
}
