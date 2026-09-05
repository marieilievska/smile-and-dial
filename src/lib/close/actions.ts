"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

import { appBaseUrl } from "@/lib/app-url";
import { getScheduledEventHostEmail } from "@/lib/calendly/api";

import {
  createCloseLead,
  createCloseNote,
  createCloseTask,
  createCloseWebhookSubscription,
  deleteCloseWebhookSubscription,
  ensureCloseLeadCustomFields,
  findCloseLeadByEmail,
  findCloseUserByEmail,
  getCloseMe,
  setCloseLeadCustomFields,
} from "./api";
import {
  buildHandoffNote,
  buildHandoffTaskText,
  pickKeyAnswers,
} from "./handoff";
import { CLOSE_WEBHOOK_EVENTS } from "./webhook";

function makeServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createAdminClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type ServiceClient = ReturnType<typeof makeServiceClient>;

/** Connect the signed-in user's own Close account by pasting an API key.
 *  Per-user: the AI sends from the campaign owner's Close. Connecting also
 *  subscribes Close's webhook to us (reply tracking) — see
 *  setupCloseWebhook. A webhook failure is returned as a `warning`, not an
 *  error: the key IS saved and the card offers "Enable reply tracking". */
export async function saveCloseConnection(
  apiKey: string,
): Promise<{ error: string | null; warning?: string }> {
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

  const hook = await setupCloseWebhook(admin, user.id, key);
  revalidatePath("/settings/integrations");
  if (hook.error) {
    return {
      error: null,
      warning: `Connected, but reply tracking couldn't be enabled: ${hook.error}`,
    };
  }
  return { error: null };
}

export async function disconnectClose(): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };
  const admin = makeServiceClient();

  // Best-effort: remove the webhook subscription first, so Close stops
  // posting to a route that would reject every delivery once the key is
  // gone (and its own health-check doesn't flag us). The columns are cleared
  // regardless — without the API key there is nothing left to verify with.
  const { data: integ } = await admin
    .from("user_integrations")
    .select("close_api_key, close_webhook_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (integ?.close_webhook_id && integ.close_api_key) {
    await deleteCloseWebhookSubscription(
      integ.close_api_key,
      integ.close_webhook_id,
    ).catch(() => false);
  }

  await admin
    .from("user_integrations")
    .update({
      close_api_key: null,
      close_connected_at: null,
      close_webhook_id: null,
      close_webhook_signature_key: null,
      close_webhook_created_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", user.id);
  revalidatePath("/settings/integrations");
  return { error: null };
}

/** Create (or re-create) this user's Close webhook subscription and store its
 *  id + signature key. Close posts `activity.email created` and
 *  `activity.sms created` to `/api/close/webhook?u=<user_id>`; the route
 *  verifies every delivery against the stored key.
 *
 *  An existing subscription is deleted and a fresh one created ("Refresh"
 *  semantics): the URL is rebuilt from the current app domain and the signing
 *  key rotates. Chosen over "already enabled" so a stale URL (domain move) or
 *  a subscription Close paused after repeated failures is always repaired by
 *  one click. Returns an error string on failure. */
async function setupCloseWebhook(
  admin: ServiceClient,
  userId: string,
  apiKey: string,
): Promise<{ error: string | null }> {
  const base = appBaseUrl();
  if (!base) {
    return { error: "No public app URL is configured (local dev)." };
  }

  const { data: integ } = await admin
    .from("user_integrations")
    .select("close_webhook_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (integ?.close_webhook_id) {
    // Best-effort: a stale id that 404s is fine, and even a failed delete
    // shouldn't block creating the subscription that will actually work.
    await deleteCloseWebhookSubscription(apiKey, integ.close_webhook_id).catch(
      () => false,
    );
  }

  const url = `${base}/api/close/webhook?u=${encodeURIComponent(userId)}`;
  let created: Awaited<ReturnType<typeof createCloseWebhookSubscription>>;
  try {
    created = await createCloseWebhookSubscription(apiKey, {
      url,
      events: CLOSE_WEBHOOK_EVENTS,
    });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Close request failed.",
    };
  }
  if (created.error !== null) return { error: created.error };

  const now = new Date().toISOString();
  const { error } = await admin
    .from("user_integrations")
    .update({
      close_webhook_id: created.id,
      close_webhook_signature_key: created.signatureKey,
      close_webhook_created_at: now,
      updated_at: now,
    })
    .eq("user_id", userId);
  if (error) {
    // A subscription whose key we failed to store can never verify; remove it
    // so Close doesn't keep posting deliveries the route will reject.
    await deleteCloseWebhookSubscription(apiKey, created.id).catch(() => false);
    return { error: "Couldn't store the webhook key." };
  }
  return { error: null };
}

/** Turn on (or refresh) reply tracking for the signed-in user: subscribe
 *  their Close account's inbound emails + SMS to this app. Uses THEIR Close
 *  key. See setupCloseWebhook for the re-create semantics. */
export async function enableCloseInboundWebhook(): Promise<{
  error: string | null;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const admin = makeServiceClient();
  const { data: integ } = await admin
    .from("user_integrations")
    .select("close_api_key")
    .eq("user_id", user.id)
    .maybeSingle();
  const key = integ?.close_api_key?.trim() || null;
  if (!key) return { error: "Connect Close first." };

  const result = await setupCloseWebhook(admin, user.id, key);
  revalidatePath("/settings/integrations");
  return result;
}

/** Turn off reply tracking: delete the Close subscription and clear the stored
 *  id/key so the route stops accepting deliveries for this user. If Close
 *  won't delete it, the columns are left in place and an error is returned so
 *  the user can retry — clearing them while Close keeps posting would just
 *  turn every delivery into a 401. */
export async function disableCloseInboundWebhook(): Promise<{
  error: string | null;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const admin = makeServiceClient();
  const { data: integ } = await admin
    .from("user_integrations")
    .select("close_api_key, close_webhook_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const key = integ?.close_api_key?.trim() || null;
  if (integ?.close_webhook_id && key) {
    const deleted = await deleteCloseWebhookSubscription(
      key,
      integ.close_webhook_id,
    ).catch(() => false);
    if (!deleted) {
      return { error: "Couldn't remove the subscription in Close. Try again." };
    }
  }

  const now = new Date().toISOString();
  const { error } = await admin
    .from("user_integrations")
    .update({
      close_webhook_id: null,
      close_webhook_signature_key: null,
      close_webhook_created_at: null,
      updated_at: now,
    })
    .eq("user_id", user.id);
  revalidatePath("/settings/integrations");
  return { error: error ? "Couldn't turn off reply tracking." : null };
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

  // All calls for the lead (newest first), with outcome + campaign for the note.
  const { data: callRows } = await admin
    .from("calls")
    .select(
      "id, campaign_id, summary, extracted_data, started_at, outcome, " +
        "elevenlabs_conversation_id, agent:agents(elevenlabs_agent_id), " +
        "campaign:campaigns(name)",
    )
    .eq("lead_id", leadId)
    .order("started_at", { ascending: false })
    .limit(20);
  const calls = (callRows ?? []) as unknown as {
    id: string;
    campaign_id: string | null;
    summary: string | null;
    extracted_data: Record<string, unknown> | null;
    started_at: string | null;
    outcome: string | null;
    elevenlabs_conversation_id: string | null;
    agent: { elevenlabs_agent_id: string | null } | null;
    campaign: { name: string | null } | null;
  }[];
  const primary =
    calls.find(
      (c) => !!c.extracted_data && Object.keys(c.extracted_data).length > 0,
    ) ??
    calls[0] ??
    null;
  // The campaign that scheduled the appointment. Appointments (calendly_events)
  // don't store the campaign that booked them, so we use the lead's most recent
  // call's campaign as the stand-in — correct while a lead runs on a single
  // campaign. Revisit (store campaign on the appointment) once leads run across
  // multiple campaigns and this can diverge.
  const utmCampaign = calls[0]?.campaign?.name ?? null;

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

  // Custom field values → {label, value}[], excluding any that duplicate a
  // hardcoded key answer (they'd otherwise show twice).
  const RESERVED_CF_SLUGS = new Set([
    "lead_response_time",
    "decision_maker_reached",
  ]);
  const [{ data: cvRows }, { data: defs }] = await Promise.all([
    admin
      .from("lead_custom_values")
      .select("custom_field_id, value")
      .eq("lead_id", leadId),
    admin.from("custom_field_defs").select("id, name, slug"),
  ]);
  const defById = new Map((defs ?? []).map((d) => [d.id, d] as const));
  const customFields = (cvRows ?? [])
    .map((v) => {
      const d = defById.get(v.custom_field_id);
      return {
        slug: d?.slug ?? "",
        label: d?.name ?? "",
        value: v.value == null ? "" : String(v.value),
      };
    })
    .filter(
      (f) =>
        f.label && f.value.trim().length > 0 && !RESERVED_CF_SLUGS.has(f.slug),
    )
    .map((f) => ({ label: f.label, value: f.value }));

  // Key answers are drawn from ALL of the lead's calls, not just the newest one
  // that carries extracted data. A short follow-up call's extraction can be
  // noisy (e.g. it reports the decision-maker as NOT reached because it only got
  // a gatekeeper), which previously overwrote an earlier call that did reach the
  // owner. pickKeyAnswers takes the truthful signal across calls.
  const { decisionMakerReached, leadResponseTime } = pickKeyAnswers(
    calls.map((c) => ({ extractedData: c.extracted_data })),
  );

  // Rolling per-campaign summary — the richest "what the lead said / is
  // interested in" digest we have (facts-only, cross-call). Prefer the summary
  // for the packaged call's campaign; else the most recently updated one.
  //
  // Sent WHOLE. This used to strip everything after the literal string
  // "Already answered", which the note no longer contains — so the split would
  // have silently stopped matching anyway. The note's fact bullets are exactly
  // what a closer wants (their hours, their booking software, their objection)
  // and "don't re-ask" is good advice for a human closer too.
  const primaryCampaignId = primary?.campaign_id ?? null;
  const { data: summaryRows } = await admin
    .from("lead_campaign_summaries")
    .select("campaign_id, ai_summary, updated_at")
    .eq("lead_id", leadId)
    .order("updated_at", { ascending: false });
  const summaryRow =
    (primaryCampaignId
      ? (summaryRows ?? []).find((s) => s.campaign_id === primaryCampaignId)
      : undefined) ??
    (summaryRows ?? [])[0] ??
    null;
  const rawSummary =
    typeof summaryRow?.ai_summary === "string" ? summaryRow.ai_summary : null;
  const contextSummary = rawSummary ? rawSummary.trim() || null : null;

  // Build per-call history (oldest→newest; DB query was desc, so reverse).
  const callHistory = [...calls].reverse().map((c) => {
    const url =
      c.elevenlabs_conversation_id && c.agent?.elevenlabs_agent_id
        ? `${EL_HISTORY_BASE}/${c.agent.elevenlabs_agent_id}/history/${c.elevenlabs_conversation_id}`
        : null;
    return {
      startedAt: c.started_at,
      outcome: c.outcome,
      summary: c.summary,
      recordingUrl: url,
    };
  });

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
    calls: callHistory,
    leadResponseTime,
    decisionMakerReached,
    appointment: appt
      ? // eventLink is null on purpose: calendly_events only stores the API
        // event URI (api.calendly.com/scheduled_events/…), not a human-openable
        // link, so the note shows the time only.
        { scheduledAt: appt.scheduled_at, eventLink: null }
      : null,
    contextSummary,
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
  // unassigned. Best-effort: the whole block is wrapped so a transient Close /
  // Calendly network error can NEVER fail a handoff whose note already posted.
  let assignee: { id: string } | null = null;
  let task: { id: string } | null = null;
  try {
    const hostEmail =
      appt?.event_uri && calendlyToken
        ? await getScheduledEventHostEmail(appt.event_uri, calendlyToken)
        : null;
    assignee =
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
    task = await createCloseTask(closeKey, {
      closeLeadId: ref.leadId,
      text: taskText,
      assignedTo: assignee?.id ?? null,
      dueDate: new Date().toISOString().slice(0, 10),
    });
    if (!task) {
      console.error("lead_handoff task creation failed", { leadId });
    }
  } catch (err) {
    console.error("lead_handoff task block failed", {
      leadId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // UTM attribution on the Close lead so the sales team can see these came from
  // the AI calling. Best-effort — a Close custom-field hiccup never fails the
  // handoff (the note already posted).
  try {
    // Use Close's existing UTM lead fields ("UTM Source" / "UTM Medium" /
    // "UTM Campaign"). ensureCloseLeadCustomFields matches punctuation-insensitively,
    // so it reuses these instead of creating "utm_source"-style duplicates.
    const ids = await ensureCloseLeadCustomFields(closeKey, [
      "UTM Source",
      "UTM Medium",
      "UTM Campaign",
    ]);
    const utm: Record<string, string> = {
      "UTM Source": "smile_dial",
      "UTM Medium": "ai_call",
      ...(utmCampaign ? { "UTM Campaign": utmCampaign } : {}),
    };
    const utmValues = Object.entries(utm)
      .filter(([name]) => ids[name])
      .map(([name, value]) => ({ fieldId: ids[name], value }));
    if (utmValues.length) {
      await setCloseLeadCustomFields(closeKey, ref.leadId, utmValues);
    }
  } catch (err) {
    console.error("lead_handoff utm block failed", {
      leadId,
      message: err instanceof Error ? err.message : String(err),
    });
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
      packaged_call_id: primary?.id ?? null,
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
