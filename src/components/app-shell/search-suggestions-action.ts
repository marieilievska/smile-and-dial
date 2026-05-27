"use server";

import { createClient } from "@/lib/supabase/server";

export type LeadSuggestion = {
  id: string;
  company: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
};

const MAX_SUGGESTIONS = 8;

/** Returns up to MAX_SUGGESTIONS leads matching the given query.
 *  Matches on company, business_phone, and business_email — same
 *  fields the /leads page table search uses, so the dropdown mirrors
 *  the eventual full-results experience.
 *
 *  Used by the global top-bar search input to render an autocomplete
 *  dropdown that lets the user jump straight to a lead without going
 *  through the leads list. */
export async function fetchLeadSuggestions(
  query: string,
): Promise<{ items: LeadSuggestion[] }> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return { items: [] };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { items: [] };

  // Same Postgres-safe ilike trio the leads-query helper uses.
  const safe = trimmed.replace(/[%,()\\*]/g, "").trim();
  if (!safe) return { items: [] };

  const { data } = await supabase
    .from("leads")
    .select("id, company, business_phone, city, state")
    .is("deleted_at", null)
    .or(
      `company.ilike.%${safe}%,business_phone.ilike.%${safe}%,business_email.ilike.%${safe}%`,
    )
    .order("updated_at", { ascending: false })
    .limit(MAX_SUGGESTIONS);

  return {
    items: (data ?? []).map((r) => ({
      id: r.id,
      company: r.company,
      phone: r.business_phone,
      city: r.city,
      state: r.state,
    })),
  };
}
