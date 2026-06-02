"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

import { renderTemplate, type TemplateContext } from "./templates";

function makeServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createAdminClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Connect the signed-in user's own Close account by pasting an API key.
 *  Per-user: the AI sends from the campaign owner's Close. (Live send itself
 *  is a separate build; this stores the credential.) */
export async function saveCloseConnection(
  apiKey: string,
): Promise<{ error: string | null }> {
  const key = apiKey.trim();
  if (!key) return { error: "Paste your Close API key." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const admin = makeServiceClient();
  const now = new Date().toISOString();
  const { error } = await admin.from("user_integrations").upsert(
    {
      user_id: user.id,
      close_api_key: key,
      close_connected_at: now,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );
  if (error) return { error: "Couldn't save the connection." };
  revalidatePath("/settings/integrations");
  return { error: null };
}

export async function disconnectClose(): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };
  const admin = makeServiceClient();
  await admin
    .from("user_integrations")
    .update({
      close_api_key: null,
      close_connected_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);
  revalidatePath("/settings/integrations");
  return { error: null };
}

/** Send an email via Close (mock). The agent's `send_email` tool calls into
 *  this, and the lead-detail Activity area exposes a manual send. In mock
 *  mode we render the template, write the `emails` row with status=sent
 *  and a fake close_message_id; live mode will POST to Close. */
export async function sendEmail(input: {
  leadId: string;
  templateId: string;
  campaignId?: string;
  callId?: string;
}): Promise<{ error: string | null; emailId?: string }> {
  if (process.env.CLOSE_LIVE === "live") {
    return {
      error:
        "Live Close email send isn't implemented yet — leave CLOSE_LIVE unset to use mock mode.",
    };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: lead } = await supabase
    .from("leads")
    .select("*, list:lists(name)")
    .eq("id", input.leadId)
    .single();
  if (!lead) return { error: "Lead not found." };
  if (!lead.business_email) return { error: "Lead has no email." };

  const { data: template } = await supabase
    .from("email_templates")
    .select("id, name, subject, body, owner_id")
    .eq("id", input.templateId)
    .single();
  if (!template) return { error: "Template not found." };

  // Pull custom field values + owner profile for the template context.
  const [{ data: customValues }, { data: defs }, { data: ownerProfile }] =
    await Promise.all([
      supabase
        .from("lead_custom_values")
        .select("custom_field_id, value")
        .eq("lead_id", lead.id),
      supabase.from("custom_field_defs").select("id, name"),
      supabase
        .from("profiles")
        .select("full_name")
        .eq("id", lead.owner_id)
        .single(),
    ]);
  const defById = new Map((defs ?? []).map((d) => [d.id, d.name] as const));
  const customFields: Record<string, string> = {};
  for (const v of customValues ?? []) {
    const slug = defById.get(v.custom_field_id);
    if (slug && v.value != null) customFields[slug] = String(v.value);
  }

  const leadRecord = lead as unknown as Record<string, unknown>;
  const ctx: TemplateContext = {
    lead: {
      company: leadRecord.company as string | null | undefined,
      business_phone: leadRecord.business_phone as string | null | undefined,
      business_email: leadRecord.business_email as string | null | undefined,
      owner_name: leadRecord.owner_name as string | null | undefined,
      manager_name: leadRecord.manager_name as string | null | undefined,
      employee_name: leadRecord.employee_name as string | null | undefined,
      city: leadRecord.city as string | null | undefined,
      state: leadRecord.state as string | null | undefined,
    },
    owner: { full_name: ownerProfile?.full_name ?? null },
    customFields,
  };

  const subject = renderTemplate(template.subject, ctx);
  const body = renderTemplate(template.body, ctx);

  const admin = makeServiceClient();
  const { data: email, error: emailErr } = await admin
    .from("emails")
    .insert({
      lead_id: lead.id,
      owner_id: lead.owner_id,
      campaign_id: input.campaignId ?? null,
      call_id: input.callId ?? null,
      direction: "sent",
      subject,
      body,
      to_address: leadRecord.business_email as string,
      from_address: ownerProfile?.full_name
        ? `${ownerProfile.full_name} via Close`
        : "Close mock",
      close_message_id: `mock-msg-${Date.now()}`,
      status: "sent",
      template_id: template.id,
    })
    .select("id")
    .single();
  if (emailErr || !email) return { error: "Could not send email." };

  await admin
    .from("email_templates")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", template.id);

  revalidatePath(`/leads`);
  return { error: null, emailId: email.id };
}
