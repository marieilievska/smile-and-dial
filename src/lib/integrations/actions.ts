"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type IntegrationResult = { error: string | null };

/**
 * Save the ElevenLabs allowed voice IDs. Round L1 — the API key moved
 * out of this table and into the server env (`ELEVENLABS_API_KEY`),
 * so only the voice-id allowlist remains tenant-configurable.
 */
export async function updateElevenLabsSettings(input: {
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

  const { error } = await supabase
    .from("app_settings")
    .update({
      elevenlabs_voice_ids: input.voiceIds.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) return { error: "Could not save the settings." };

  revalidatePath("/settings/integrations");
  return { error: null };
}
