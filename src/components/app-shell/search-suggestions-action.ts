"use server";

import { formatPhone } from "@/lib/format-phone";
import { createClient } from "@/lib/supabase/server";

/** One typeahead hit, from any searchable entity. `href` is where picking it
 *  navigates; `sublabel` is the dim secondary line. */
export type SearchHit = {
  kind: "lead" | "campaign" | "agent" | "list";
  id: string;
  label: string;
  sublabel: string | null;
  href: string;
};

export type GlobalSuggestions = {
  leads: SearchHit[];
  campaigns: SearchHit[];
  agents: SearchHit[];
  lists: SearchHit[];
};

const EMPTY: GlobalSuggestions = {
  leads: [],
  campaigns: [],
  agents: [],
  lists: [],
};

/** Humanize a campaign status for the sublabel. */
function statusLabel(status: string | null): string {
  if (!status) return "Campaign";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Top-bar typeahead across the objects a teammate navigates to: leads,
 * campaigns, agents, and lists. Every query runs on the user client, so RLS
 * scopes each entity to the caller (members see only their own; admins see
 * all) — there are no new policies here. Calls are intentionally excluded
 * (they're reached via their lead, and /calls has its own search).
 */
export async function fetchGlobalSuggestions(
  query: string,
): Promise<GlobalSuggestions> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return EMPTY;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return EMPTY;

  // Same Postgres-safe scrub the leads-query helper uses before an ilike.
  const safe = trimmed.replace(/[%,()\\*]/g, "").trim();
  if (!safe) return EMPTY;
  const like = `%${safe}%`;

  const [leadsRes, campaignsRes, agentsRes, listsRes] = await Promise.all([
    supabase
      .from("leads")
      .select("id, company, business_phone, city, state")
      .is("deleted_at", null)
      .or(
        `company.ilike.${like},business_phone.ilike.${like},business_email.ilike.${like}`,
      )
      .order("updated_at", { ascending: false })
      .limit(5),
    supabase
      .from("campaigns")
      .select("id, name, status")
      .ilike("name", like)
      .order("created_at", { ascending: false })
      .limit(3),
    supabase
      .from("agents")
      .select("id, name")
      .ilike("name", like)
      .order("created_at", { ascending: false })
      .limit(3),
    supabase
      .from("lists")
      .select("id, name")
      .ilike("name", like)
      .order("created_at", { ascending: false })
      .limit(3),
  ]);

  return {
    leads: (leadsRes.data ?? []).map((r): SearchHit => {
      const place = [r.city, r.state].filter(Boolean).join(", ");
      const phone = r.business_phone ? formatPhone(r.business_phone) : "";
      return {
        kind: "lead",
        id: r.id,
        label: r.company || "Untitled lead",
        sublabel: [phone, place].filter(Boolean).join(" · ") || null,
        href: `/leads/${r.id}`,
      };
    }),
    campaigns: (campaignsRes.data ?? []).map(
      (r): SearchHit => ({
        kind: "campaign",
        id: r.id,
        label: r.name,
        sublabel: statusLabel(r.status),
        href: "/campaigns",
      }),
    ),
    agents: (agentsRes.data ?? []).map(
      (r): SearchHit => ({
        kind: "agent",
        id: r.id,
        label: r.name,
        sublabel: "Agent",
        href: `/settings/agents/${r.id}/edit`,
      }),
    ),
    lists: (listsRes.data ?? []).map(
      (r): SearchHit => ({
        kind: "list",
        id: r.id,
        label: r.name,
        sublabel: "List",
        href: `/leads?list=${r.id}`,
      }),
    ),
  };
}
