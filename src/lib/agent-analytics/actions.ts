"use server";

import { revalidatePath } from "next/cache";

import { createClient as createAdminClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

const AGENT_ANALYTICS_PATH = "/reporting";

type SupabaseAdmin = ReturnType<typeof createAdminClient<Database>>;

function adminClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createAdminClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** True when the caller is a signed-in admin. All Agent Analytics writes are
 *  admin-only (the page is admin-gated too — this is the server-side backstop). */
async function isCallerAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  return me?.role === "admin";
}

/** Save an operator's theme / suggested-action annotation on a call (Voice of
 *  Customer tab). Empty string clears the field. */
export async function saveCallAnnotation(input: {
  callId: string;
  field: "theme" | "suggested_action";
  value: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const value = input.value.trim() || null;
  const patch =
    input.field === "theme" ? { theme: value } : { suggested_action: value };
  const { error } = await adminClient()
    .from("calls")
    .update(patch)
    .eq("id", input.callId);
  return { error: error ? "Could not save." : null };
}

/** Upsert the per-day dashboard note (an operator's explanation of why a KPI
 *  moved that day). Empty clears it. Admin-only; one row per Eastern day. */
export async function upsertDashboardNote(input: {
  day: string;
  note: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) return { error: "Invalid day." };
  const { error } = await adminClient().from("dashboard_notes").upsert(
    {
      day: input.day,
      note: input.note.trim(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "day" },
  );
  if (error) return { error: "Could not save the note." };
  revalidatePath(AGENT_ANALYTICS_PATH);
  return { error: null };
}

/** Save a team edit on a hot lead (status / owner / next step / date
 *  contacted). Status falls back to "New" rather than null (it's NOT NULL).
 *  Empty string clears the other fields. */
export async function saveHotLeadField(input: {
  id: string;
  field: "status" | "owner" | "next_step" | "date_contacted";
  value: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const value = input.value.trim() || null;
  const patch: Database["public"]["Tables"]["hot_leads"]["Update"] = {};
  if (input.field === "status") patch.status = value ?? "New";
  else if (input.field === "owner") patch.owner = value;
  else if (input.field === "next_step") patch.next_step = value;
  else if (input.field === "date_contacted") patch.date_contacted = value;
  const { error } = await adminClient()
    .from("hot_leads")
    .update(patch)
    .eq("id", input.id);
  return { error: error ? "Could not save." : null };
}

// ---------------------------------------------------------------------------
// App Changelog (manual log: add / edit-inline / delete)
// ---------------------------------------------------------------------------

type ChangelogField =
  | "change_date"
  | "area"
  | "change_type"
  | "summary"
  | "details"
  | "status"
  | "owner"
  | "ticket_link";

/** Add a changelog entry from the Add form. Owner is intentionally omitted.
 *  change_date defaults to today if blank/invalid; status defaults to "Open". */
export async function createChangelogEntry(input: {
  change_date: string;
  change_type: string;
  status: string;
  summary: string;
  details: string;
  area: string;
  ticket_link: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const t = (s: string) => s.trim() || null;
  const patch: Database["public"]["Tables"]["app_changelog"]["Insert"] = {
    change_type: t(input.change_type),
    status: input.status.trim() || "Open",
    summary: t(input.summary),
    details: t(input.details),
    area: t(input.area),
    ticket_link: t(input.ticket_link),
  };
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.change_date)) {
    patch.change_date = input.change_date;
  }
  const { error } = await adminClient().from("app_changelog").insert(patch);
  if (error) return { error: "Could not add entry." };
  revalidatePath(AGENT_ANALYTICS_PATH);
  return { error: null };
}

export async function updateChangelogField(input: {
  id: string;
  field: ChangelogField;
  value: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const value = input.value.trim() || null;
  // change_date + status are NOT NULL — never write null into them.
  if (input.field === "change_date" && !value) return { error: null };
  const patch: Database["public"]["Tables"]["app_changelog"]["Update"] = {
    [input.field]: input.field === "status" ? (value ?? "Open") : value,
  };
  const { error } = await adminClient()
    .from("app_changelog")
    .update(patch)
    .eq("id", input.id);
  return { error: error ? "Could not save." : null };
}

export async function deleteChangelogEntry(input: {
  id: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("app_changelog")
    .delete()
    .eq("id", input.id);
  if (error) return { error: "Could not delete." };
  revalidatePath(AGENT_ANALYTICS_PATH);
  return { error: null };
}

// ---------------------------------------------------------------------------
// Agent Prompt Log (manual log: add / edit-inline / delete)
// ---------------------------------------------------------------------------

type PromptLogField =
  | "log_date"
  | "version"
  | "changed"
  | "what_changed"
  | "why"
  | "full_prompt";

/** Add a blank prompt-log row (DB defaults: today's date, "No change"). */
export async function createPromptLogEntry(): Promise<{
  error: string | null;
}> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const { error } = await adminClient().from("agent_prompt_log").insert({});
  if (error) return { error: "Could not add entry." };
  revalidatePath(AGENT_ANALYTICS_PATH);
  return { error: null };
}

export async function updatePromptLogField(input: {
  id: string;
  field: PromptLogField;
  value: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const value = input.value.trim() || null;
  // log_date + changed are NOT NULL — never write null into them.
  if (input.field === "log_date" && !value) return { error: null };
  const patch: Database["public"]["Tables"]["agent_prompt_log"]["Update"] = {
    [input.field]: input.field === "changed" ? (value ?? "No change") : value,
  };
  const { error } = await adminClient()
    .from("agent_prompt_log")
    .update(patch)
    .eq("id", input.id);
  return { error: error ? "Could not save." : null };
}

export async function deletePromptLogEntry(input: {
  id: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("agent_prompt_log")
    .delete()
    .eq("id", input.id);
  if (error) return { error: "Could not delete." };
  revalidatePath(AGENT_ANALYTICS_PATH);
  return { error: null };
}
