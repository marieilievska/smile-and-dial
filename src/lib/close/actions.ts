"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

import { getScheduledEventHostEmail } from "@/lib/calendly/api";

import {
  closeSenderEmail,
  createCloseLead,
  createCloseNote,
  createCloseTask,
  findCloseLeadByEmail,
  findCloseUserByEmail,
  getCloseMe,
  sendCloseEmail,
} from "./api";
import { buildHandoffNote, buildHandoffTaskText } from "./handoff";
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

/** Send an email via Close. The agent's `send_email` tool calls into this, and
 *  the lead-detail Activity area exposes a manual send. When the lead's owner
 *  has connected their Close account, this REALLY sends: it finds-or-creates the
 *  contact in Close and posts an outbox email from the owner's connected email
 *  account. Owners with no Close connection fall back to logging the email
 *  locally so the flow still works for them. */
export async function sendEmail(input: {
  leadId: string;
  templateId: string;
  campaignId?: string;
  callId?: string;
}): Promise<{ error: string | null; emailId?: string }> {
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
  const toAddress = leadRecord.business_email as string;

  // Send from the LEAD OWNER's own Close account (per-user). If they've
  // connected Close, this really sends via their connected email; otherwise we
  // log the email locally (mock) so the flow still works without Close.
  const { data: ownerIntegration } = await admin
    .from("user_integrations")
    .select("close_api_key")
    .eq("user_id", lead.owner_id)
    .maybeSingle();
  const closeKey = ownerIntegration?.close_api_key?.trim() || null;

  let closeMessageId: string;
  let fromAddress: string;

  if (closeKey) {
    const senderEmail = await closeSenderEmail(closeKey);
    if (!senderEmail) {
      return {
        error:
          "Your Close account has no connected email to send from. Connect an email account in Close, then try again.",
      };
    }
    const sender = ownerProfile?.full_name
      ? `${ownerProfile.full_name} <${senderEmail}>`
      : senderEmail;

    // Find the contact in Close, creating the lead there if it's new.
    const contactName =
      (leadRecord.owner_name as string | null | undefined) ||
      (leadRecord.manager_name as string | null | undefined) ||
      null;
    let ref = await findCloseLeadByEmail(closeKey, toAddress);
    if (!ref) {
      ref = await createCloseLead(closeKey, {
        companyName: (leadRecord.company as string | null | undefined) ?? null,
        contactName,
        email: toAddress,
        phone: (leadRecord.business_phone as string | null | undefined) ?? null,
      });
    }
    if (!ref) {
      return { error: "Could not create the contact in Close." };
    }

    const sent = await sendCloseEmail(closeKey, {
      leadId: ref.leadId,
      contactId: ref.contactId,
      to: toAddress,
      subject,
      bodyText: body,
      sender,
    });
    if (sent.error || !sent.id) {
      return {
        error:
          `Couldn't send the email through Close. ${sent.error ?? ""}`.trim(),
      };
    }
    closeMessageId = sent.id;
    fromAddress = sender;
  } else {
    // No Close connected for this owner — log the email without sending.
    closeMessageId = `mock-msg-${Date.now()}`;
    fromAddress = ownerProfile?.full_name
      ? `${ownerProfile.full_name} via Close`
      : "Close mock";
  }

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
      to_address: toAddress,
      from_address: fromAddress,
      close_message_id: closeMessageId,
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

const EL_HISTORY_BASE = "https://elevenlabs.io/app/agents/agents";

/** Push a lead to the closer's Close CRM: find/create the Close lead + contact,
 *  attach a rich handoff note, and log the handoff. Admin-only. Does NOT change
 *  the lead's status or dialer eligibility. Re-runnable (a fresh note each time;
 *  the Close lead is deduped by email). */
export async function handoffLeadToClose(
  leadId: string,
): Promise<{ error: string | null; closeLeadId?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") return { error: "Admins only." };

  const admin = makeServiceClient();

  // Lead.
  const { data: leadRaw } = await admin
    .from("leads")
    .select(
      "id, owner_id, company, owner_name, manager_name, employee_name, " +
        "business_phone, business_email, timezone, city, state",
    )
    .eq("id", leadId)
    .maybeSingle();
  const lead = leadRaw as {
    id: string;
    owner_id: string;
    company: string | null;
    owner_name: string | null;
    manager_name: string | null;
    employee_name: string | null;
    business_phone: string | null;
    business_email: string | null;
    timezone: string | null;
    city: string | null;
    state: string | null;
  } | null;
  if (!lead) return { error: "Lead not found." };

  // Owner's Close key.
  const { data: integ } = await admin
    .from("user_integrations")
    .select("close_api_key, calendly_api_key")
    .eq("user_id", lead.owner_id)
    .maybeSingle();
  const closeKey = integ?.close_api_key?.trim() || null;
  const calendlyToken = integ?.calendly_api_key?.trim() || null;
  if (!closeKey) {
    return { error: "Connect Close in Settings → Integrations first." };
  }

  // Packaged call: most recent WITH a summary, else most recent.
  const { data: callRows } = await admin
    .from("calls")
    .select(
      "id, summary, extracted_data, started_at, elevenlabs_conversation_id, " +
        "agent:agents(elevenlabs_agent_id)",
    )
    .eq("lead_id", leadId)
    .order("started_at", { ascending: false })
    .limit(20);
  const calls = (callRows ?? []) as unknown as {
    id: string;
    summary: string | null;
    extracted_data: Record<string, unknown> | null;
    started_at: string | null;
    elevenlabs_conversation_id: string | null;
    agent: { elevenlabs_agent_id: string | null } | null;
  }[];
  const packaged = calls.find((c) => c.summary) ?? calls[0] ?? null;

  // Appointment: earliest upcoming, else most recent.
  const nowIso = new Date().toISOString();
  const { data: upcoming } = await admin
    .from("calendly_events")
    .select("scheduled_at, event_uri")
    .eq("lead_id", leadId)
    .eq("status", "scheduled")
    .gte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  let appt = upcoming ?? null;
  if (!appt) {
    const { data: recent } = await admin
      .from("calendly_events")
      .select("scheduled_at, event_uri")
      .eq("lead_id", leadId)
      .order("scheduled_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    appt = recent ?? null;
  }

  // Custom field values → {label, value}[].
  const [{ data: cvRows }, { data: defs }] = await Promise.all([
    admin
      .from("lead_custom_values")
      .select("custom_field_id, value")
      .eq("lead_id", leadId),
    admin.from("custom_field_defs").select("id, name"),
  ]);
  const defName = new Map((defs ?? []).map((d) => [d.id, d.name] as const));
  const customFields = (cvRows ?? [])
    .map((v) => ({
      label: defName.get(v.custom_field_id) ?? "",
      value: v.value == null ? "" : String(v.value),
    }))
    .filter((f) => f.label && f.value.trim().length > 0);

  const extracted = packaged?.extracted_data ?? {};
  const recordingUrl =
    packaged?.elevenlabs_conversation_id && packaged.agent?.elevenlabs_agent_id
      ? `${EL_HISTORY_BASE}/${packaged.agent.elevenlabs_agent_id}/history/${packaged.elevenlabs_conversation_id}`
      : null;

  const note = buildHandoffNote({
    lead: {
      company: lead.company,
      ownerName: lead.owner_name,
      managerName: lead.manager_name,
      employeeName: lead.employee_name,
      businessPhone: lead.business_phone,
      businessEmail: lead.business_email,
      timezone: lead.timezone,
      city: lead.city,
      state: lead.state,
    },
    call: packaged
      ? {
          summary: packaged.summary,
          disposition:
            typeof extracted.disposition === "string"
              ? extracted.disposition
              : null,
          leadResponseTime:
            typeof extracted.lead_response_time === "string"
              ? extracted.lead_response_time
              : null,
          decisionMakerReached:
            typeof extracted.decision_maker_reached === "string"
              ? extracted.decision_maker_reached
              : null,
          startedAt: packaged.started_at,
          recordingUrl,
        }
      : null,
    appointment: appt
      ? // eventLink is null on purpose: calendly_events only stores the API
        // event URI (api.calendly.com/scheduled_events/…), not a human-openable
        // link, so the note shows the time only.
        { scheduledAt: appt.scheduled_at, eventLink: null }
      : null,
    customFields,
  });

  // Find/create the Close lead, then attach the note.
  const contactName =
    lead.owner_name || lead.manager_name || lead.employee_name || null;
  const email = lead.business_email?.trim() || null;
  let ref = email ? await findCloseLeadByEmail(closeKey, email) : null;
  if (!ref) {
    ref = await createCloseLead(closeKey, {
      companyName: lead.company,
      contactName,
      email,
      phone: lead.business_phone,
    });
  }
  if (!ref) return { error: "Could not create the lead in Close." };

  const posted = await createCloseNote(closeKey, {
    closeLeadId: ref.leadId,
    note,
  });
  if (!posted) return { error: "Could not post the handoff note to Close." };

  // Also create a Close TASK assigned to the appointment's closer, so it lands
  // in that person's Close Inbox. Assignee = the Calendly event's host (matched
  // to a Close user by email); falls back to the account owner (/me), then
  // unassigned. Best-effort: a failed task never fails the handoff.
  const hostEmail =
    appt?.event_uri && calendlyToken
      ? await getScheduledEventHostEmail(appt.event_uri, calendlyToken)
      : null;
  const assignee =
    (hostEmail ? await findCloseUserByEmail(closeKey, hostEmail) : null) ??
    (await getCloseMe(closeKey));
  const taskText = buildHandoffTaskText({
    company: lead.company,
    ownerName: lead.owner_name,
    managerName: lead.manager_name,
    employeeName: lead.employee_name,
    businessPhone: lead.business_phone,
    businessEmail: lead.business_email,
    timezone: lead.timezone,
    appointmentAt: appt?.scheduled_at ?? null,
  });
  const task = await createCloseTask(closeKey, {
    closeLeadId: ref.leadId,
    text: taskText,
    assignedTo: assignee?.id ?? null,
    dueDate: new Date().toISOString().slice(0, 10),
  });
  if (!task) {
    console.error("lead_handoff task creation failed", { leadId });
  }

  // Best-effort audit log. The handoff itself (the Close note) already
  // succeeded, so a failed log must NOT return an error — that would show the
  // operator a failure and prompt a re-send, duplicating the note in Close.
  // Surface it to server logs instead so the failure isn't invisible.
  const { error: logError } = await admin.from("system_events").insert({
    kind: "lead_handoff",
    actor_user_id: user.id,
    ref_table: "leads",
    ref_id: leadId,
    payload: {
      close_lead_id: ref.leadId,
      note_id: posted.id,
      packaged_call_id: packaged?.id ?? null,
      by_name: me?.full_name ?? null,
      task_id: task?.id ?? null,
      task_assigned_to: assignee?.id ?? null,
      at: new Date().toISOString(),
    },
  });
  if (logError) {
    console.error("lead_handoff audit log failed", {
      leadId,
      message: logError.message,
    });
  }

  revalidatePath("/leads/[id]", "page");
  return { error: null, closeLeadId: ref.leadId };
}
