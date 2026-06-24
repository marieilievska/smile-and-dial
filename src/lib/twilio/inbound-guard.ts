import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { pointNumberWebhooks } from "@/lib/twilio/numbers";

export type InboundGuardSummary = {
  ok: true;
  checked: number;
  repointed: number;
  failed: number;
};

/**
 * Re-assert every active number's Twilio voice + status webhooks back at OUR
 * app. ElevenLabs silently re-hijacks an imported number's voice webhook to its
 * own inbound handler (`api.elevenlabs.io/twilio/inbound_call`) — sometimes well
 * after the initial import — which breaks our app-bridged inbound (incoming
 * calls would hit ElevenLabs instead of /api/twilio/voice-inbound, so no lead is
 * created, no call is logged, and nothing bridges to the campaign's agent).
 *
 * `ensureNumberImportedToElevenLabs` only re-points on the FIRST import, so this
 * periodic guard catches the drift. Idempotent: re-pointing a number that's
 * already correct is a harmless no-op write. Outbound is unaffected (ElevenLabs
 * places outbound through its API, not this webhook).
 */
export async function repointInboundWebhooks(
  supabase: SupabaseClient<Database>,
): Promise<InboundGuardSummary> {
  const { data: nums } = await supabase
    .from("twilio_numbers")
    .select("id, twilio_sid")
    .is("released_at", null)
    .not("twilio_sid", "is", null);

  let repointed = 0;
  let failed = 0;
  for (const n of nums ?? []) {
    const sid = (n as { twilio_sid: string | null }).twilio_sid;
    if (!sid) continue;
    const pointed = await pointNumberWebhooks(sid);
    if (pointed.error || !pointed.voiceUrl) {
      failed++;
      continue;
    }
    await supabase
      .from("twilio_numbers")
      .update({
        voice_webhook_url: pointed.voiceUrl,
        status_webhook_url: pointed.statusCallback,
      })
      .eq("id", (n as { id: string }).id);
    repointed++;
  }

  return { ok: true, checked: (nums ?? []).length, repointed, failed };
}
