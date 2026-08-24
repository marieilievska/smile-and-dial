import "server-only";

/**
 * Live ElevenLabs credit balance for the workspace. Reads the shared account's
 * subscription (there is no per-user credit budget). Returns null on any
 * failure — the caller decides how to react (the credit guard fails open).
 *
 * EL renamed "characters" to "credits" but kept the field names, so
 * character_limit / character_count are credits.
 */
export type ElevenLabsCreditBalance = {
  remaining: number;
  limit: number;
  used: number;
  tier: string | null;
  status: string | null;
  resetUnix: number | null;
};

function apiKey(): string {
  return process.env.ELEVENLABS_API_KEY?.trim() ?? "";
}

export async function getElevenLabsCreditBalance(): Promise<ElevenLabsCreditBalance | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": key },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j: unknown = await res.json();
    const obj = (j ?? {}) as Record<string, unknown>;
    const limit = Number(obj.character_limit);
    const used = Number(obj.character_count);
    if (!Number.isFinite(limit) || !Number.isFinite(used)) return null;
    return {
      remaining: Math.max(0, limit - used),
      limit,
      used,
      tier: typeof obj.tier === "string" ? obj.tier : null,
      status: typeof obj.status === "string" ? obj.status : null,
      resetUnix: Number.isFinite(Number(obj.next_character_count_reset_unix))
        ? Number(obj.next_character_count_reset_unix)
        : null,
    };
  } catch {
    return null;
  }
}
