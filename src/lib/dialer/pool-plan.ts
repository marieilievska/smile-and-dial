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

/** One state (or Canadian province) worth buying a number in. */
export type StatePlan = {
  /** USPS state or Canadian province abbreviation. */
  region: string;
  /** Leads in this region across every area code. */
  leads: number;
  /** The area code within the region holding the most leads — buy here, so the
   *  number doubles as an EXACT match for the region's biggest pocket. */
  areaCode: string;
  /** Leads in that specific area code. */
  areaCodeLeads: number;
  /** Active pool numbers already owned anywhere in this region. */
  owned: number;
  /** How many more to buy to cover the region (>= 0). */
  suggested: number;
};

/**
 * Suggest a buy plan one row per STATE rather than one per area code.
 *
 * Area-code-level local presence is a poor investment on a nationally spread
 * list: measured on 2026-07-29, 7,768 dialable US leads sat across 305 area
 * codes with the largest holding only 102, so exact coverage costs ~100 numbers
 * to reach 60%. The same 25 numbers placed one per state reach ~81% same-state
 * coverage. Buying in each state's densest area code means each number also
 * serves as an exact match for that state's biggest single pocket.
 *
 * `regionOf` is injected so this stays pure and testable — callers pass the
 * NANP lookup.
 */
export function buildStatePlan(input: {
  /** One entry per lead — the lead's area code (callers drop nulls first). */
  leadAreaCodes: string[];
  /** Active pool numbers already owned, keyed by area code. */
  ownedByAreaCode: Record<string, number>;
  /** area code -> state/province, or null for non-geographic codes. */
  regionOf: (areaCode: string) => string | null;
  /** Reputation-safe daily dials per number. */
  dailyCap: number;
  /** Working days to spread a lead list over (so we don't over-buy). */
  workdays: number;
}): StatePlan[] {
  const cap = Math.max(1, input.dailyCap);
  const days = Math.max(1, input.workdays);

  // Leads per region, and per area code within it.
  const regionLeads = new Map<string, number>();
  const areaLeadsByRegion = new Map<string, Map<string, number>>();
  for (const ac of input.leadAreaCodes) {
    const region = ac ? input.regionOf(ac) : null;
    // Non-geographic codes (toll-free) have no region to be local to.
    if (!region) continue;
    regionLeads.set(region, (regionLeads.get(region) ?? 0) + 1);
    const perArea = areaLeadsByRegion.get(region) ?? new Map<string, number>();
    perArea.set(ac, (perArea.get(ac) ?? 0) + 1);
    areaLeadsByRegion.set(region, perArea);
  }

  // Numbers already owned, counted per region.
  const ownedByRegion = new Map<string, number>();
  for (const [ac, n] of Object.entries(input.ownedByAreaCode)) {
    const region = input.regionOf(ac);
    if (!region) continue;
    ownedByRegion.set(region, (ownedByRegion.get(region) ?? 0) + n);
  }

  const plans: StatePlan[] = [];
  for (const [region, leads] of regionLeads) {
    const perArea = areaLeadsByRegion.get(region) ?? new Map<string, number>();
    // Densest area code in the region; ties broken by area code so the
    // suggestion is stable run to run.
    const [areaCode, areaCodeLeads] = [...perArea].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0];
    const need = Math.ceil(leads / (cap * days));
    const owned = ownedByRegion.get(region) ?? 0;
    plans.push({
      region,
      leads,
      areaCode,
      areaCodeLeads,
      owned,
      suggested: Math.max(0, need - owned),
    });
  }

  // Biggest states first — that's where coverage is won.
  return plans.sort(
    (a, b) => b.leads - a.leads || a.region.localeCompare(b.region),
  );
}
