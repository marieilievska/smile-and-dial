"use server";

import { createClient } from "@/lib/supabase/server";

export type TestCallSession =
  | { signedUrl: string; agentName: string; error: null }
  | { signedUrl: null; agentName: null; error: string };

/**
 * Mint a short-lived ElevenLabs signed URL so the browser can open a REAL
 * conversation with this campaign's actual agent (its real prompt, voice, and
 * tools) from the Test Call tab. The ElevenLabs API key never leaves the
 * server. Returns a clear error when the campaign has no agent, the agent isn't
 * synced, or the agent no longer exists in ElevenLabs.
 */
export async function getTestCallSession(
  campaignId: string,
): Promise<TestCallSession> {
  const fail = (error: string): TestCallSession => ({
    signedUrl: null,
    agentName: null,
    error,
  });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("You are not signed in.");

  // RLS scopes the campaign read to the owner / admins.
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("agent_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign?.agent_id) {
    return fail("This campaign has no agent assigned yet.");
  }

  const { data: agent } = await supabase
    .from("agents")
    .select("name, elevenlabs_agent_id")
    .eq("id", campaign.agent_id)
    .maybeSingle();
  const elId = agent?.elevenlabs_agent_id?.trim();
  if (!elId) {
    return fail(
      "This campaign's agent hasn't been synced to ElevenLabs yet. Open it in Settings → Agents and save, then try again.",
    );
  }

  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    return fail("The ElevenLabs API key isn't configured on the server.");
  }

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(elId)}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (res.status === 404) {
      return fail(
        `The agent "${agent?.name ?? "for this campaign"}" no longer exists in ElevenLabs. Re-create or re-sync it from Settings → Agents.`,
      );
    }
    if (!res.ok) {
      return fail(`ElevenLabs returned ${res.status}. Please try again.`);
    }
    const data = (await res.json()) as { signed_url?: string };
    if (!data.signed_url) {
      return fail("ElevenLabs did not return a session URL.");
    }
    return {
      signedUrl: data.signed_url,
      agentName: agent?.name ?? "this agent",
      error: null,
    };
  } catch {
    return fail("Couldn't reach ElevenLabs. Please try again.");
  }
}
