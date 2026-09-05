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

/** The subset of GET /v1/user/subscription the app reads. `nextInvoice*`
 *  feed the $/credit derivation in lib/costs/refresh-rates (plan price ÷
 *  credits included). Verified live 2026-09-05:
 *    character_limit 6269494, next_invoice.amount_due_cents 99000. */
export type ElevenLabsSubscription = {
  characterLimit: number;
  characterCount: number;
  tier: string | null;
  status: string | null;
  resetUnix: number | null;
  nextInvoiceAmountDueCents: number | null;
  currency: string | null;
  billingPeriod: string | null;
};

function apiKey(): string {
  return process.env.ELEVENLABS_API_KEY?.trim() ?? "";
}

function finiteOrNull(v: unknown): number | null {
  const n = Number(v);
  return v !== null && v !== undefined && Number.isFinite(n) ? n : null;
}

/** Parse the raw subscription body. Pure — exported for the unit tests.
 *  Null unless both credit counters are numbers (the balance is meaningless
 *  otherwise). */
export function parseElevenLabsSubscription(
  body: unknown,
): ElevenLabsSubscription | null {
  const obj = (body ?? {}) as Record<string, unknown>;
  const limit = Number(obj.character_limit);
  const used = Number(obj.character_count);
  if (!Number.isFinite(limit) || !Number.isFinite(used)) return null;
  const invoice = (obj.next_invoice ?? null) as Record<string, unknown> | null;
  return {
    characterLimit: limit,
    characterCount: used,
    tier: typeof obj.tier === "string" ? obj.tier : null,
    status: typeof obj.status === "string" ? obj.status : null,
    resetUnix: finiteOrNull(obj.next_character_count_reset_unix),
    nextInvoiceAmountDueCents:
      invoice && typeof invoice === "object"
        ? finiteOrNull(invoice.amount_due_cents)
        : null,
    currency: typeof obj.currency === "string" ? obj.currency : null,
    billingPeriod:
      typeof obj.billing_period === "string" ? obj.billing_period : null,
  };
}

/** GET /v1/user/subscription, parsed. Null on any failure. */
export async function fetchElevenLabsSubscription(): Promise<ElevenLabsSubscription | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": key },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return parseElevenLabsSubscription((await res.json()) as unknown);
  } catch {
    return null;
  }
}

export async function getElevenLabsCreditBalance(): Promise<ElevenLabsCreditBalance | null> {
  const sub = await fetchElevenLabsSubscription();
  if (!sub) return null;
  return {
    remaining: Math.max(0, sub.characterLimit - sub.characterCount),
    limit: sub.characterLimit,
    used: sub.characterCount,
    tier: sub.tier,
    status: sub.status,
    resetUnix: sub.resetUnix,
  };
}
