/**
 * Pure area-code planner for the number pool. Given the area-code distribution of
 * a campaign's leads and how many numbers it already owns per area code, suggest
 * how many MORE local numbers to buy so each area's dialing volume stays under the
 * per-number daily cap (spread across a few working days). No I/O — the server
 * action gathers the inputs and calls this.
 */

export type AreaCodePlan = {
  areaCode: string;
  /** Leads whose business phone is in this area code. */
  leads: number;
  /** Active pool numbers already owned in this area code. */
  owned: number;
  /** How many more numbers to buy to cover this area locally (>= 0). */
  suggested: number;
};

export function buildPoolPlan(input: {
  /** One entry per lead — the lead's area code (callers drop nulls first). */
  leadAreaCodes: string[];
  /** Active pool numbers already owned, keyed by area code. */
  ownedByAreaCode: Record<string, number>;
  /** Reputation-safe daily dials per number. */
  dailyCap: number;
  /** Working days to spread a lead list over (so we don't over-buy). */
  workdays: number;
}): AreaCodePlan[] {
  const cap = Math.max(1, input.dailyCap);
  const days = Math.max(1, input.workdays);

  const leadCounts = new Map<string, number>();
  for (const ac of input.leadAreaCodes) {
    if (!ac) continue;
    leadCounts.set(ac, (leadCounts.get(ac) ?? 0) + 1);
  }

  const plans: AreaCodePlan[] = [];
  for (const [areaCode, leads] of leadCounts) {
    // Numbers needed so this area's leads fit under cap × days of dialing.
    const need = Math.ceil(leads / (cap * days));
    const owned = input.ownedByAreaCode[areaCode] ?? 0;
    plans.push({
      areaCode,
      leads,
      owned,
      suggested: Math.max(0, need - owned),
    });
  }
  // Biggest areas first — that's where local presence matters most.
  return plans.sort(
    (a, b) => b.leads - a.leads || a.areaCode.localeCompare(b.areaCode),
  );
}
