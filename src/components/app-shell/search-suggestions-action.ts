"use server";

import { formatPhone } from "@/lib/format-phone";
import { createClient } from "@/lib/supabase/server";

/** One typeahead hit, from any searchable entity. `href` is where picking it
 *  navigates; `sublabel` is the dim secondary line. */
export type SearchHit = {
  kind:
    | "lead"
    | "campaign"
    | "agent"
    | "list"
    | "knowledge_base"
    | "email_template"
    | "sms_template";
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
  knowledgeBases: SearchHit[];
  emailTemplates: SearchHit[];
  smsTemplates: SearchHit[];
};

const EMPTY: GlobalSuggestions = {
  leads: [],
  campaigns: [],
  agents: [],
  lists: [],
  knowledgeBases: [],
  emailTemplates: [],
  smsTemplates: [],
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

  const [leadsRes, campaignsRes, agentsRes, listsRes, kbRes, emailRes, smsRes] =
    await Promise.all([
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
      // Knowledge bases are owner-or-admin via RLS. Templates are owner-scoped
      // explicitly (matching the campaign picker) so a member sees only their own.
      supabase
        .from("knowledge_bases")
        .select("id, name")
        .ilike("name", like)
        .order("created_at", { ascending: false })
        .limit(3),
      supabase
        .from("email_templates")
        .select("id, name")
        .eq("owner_id", user.id)
        .ilike("name", like)
        .order("created_at", { ascending: false })
        .limit(3),
      supabase
        .from("sms_templates")
        .select("id, name")
        .eq("owner_id", user.id)
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
        // Deep-link: land on all campaigns and auto-open this one's settings.
        href: `/campaigns?status=all&open=${r.id}`,
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
    knowledgeBases: (kbRes.data ?? []).map(
      (r): SearchHit => ({
        kind: "knowledge_base",
        id: r.id,
        label: r.name,
        sublabel: "Knowledge base",
        href: "/settings/knowledge-bases",
      }),
    ),
    emailTemplates: (emailRes.data ?? []).map(
      (r): SearchHit => ({
        kind: "email_template",
        id: r.id,
        label: r.name,
        sublabel: "Email template",
        href: "/settings/email-templates",
      }),
    ),
    smsTemplates: (smsRes.data ?? []).map(
      (r): SearchHit => ({
        kind: "sms_template",
        id: r.id,
        label: r.name,
        sublabel: "Text template",
        href: "/settings/sms-templates",
      }),
    ),
  };
}
