import "server-only";

/**
 * Thin Close CRM REST helpers for sending an email through a user's own Close
 * account. Auth is HTTP Basic with the API key as the username and an empty
 * password. Every call is defensive: it returns null / an error string rather
 * than throwing, so the caller can fall back or surface a clear message instead
 * of writing a false "sent" record.
 */

const BASE = "https://api.close.com/api/v1";

function authHeader(apiKey: string): string {
  return "Basic " + Buffer.from(`${apiKey}:`).toString("base64");
}

export type CloseLeadRef = { leadId: string; contactId: string | null };

/** Find a Close lead by a contact email address. Returns the lead id + the
 *  matching contact id (or the lead's first contact), or null when no lead in
 *  the org has that email. */
export async function findCloseLeadByEmail(
  apiKey: string,
  email: string,
): Promise<CloseLeadRef | null> {
  const q = `email_address:"${email.replace(/"/g, "")}"`;
  const res = await fetch(
    `${BASE}/lead/?query=${encodeURIComponent(q)}&_limit=1`,
    { headers: { Authorization: authHeader(apiKey) } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: {
      id: string;
      contacts?: { id: string; emails?: { email?: string }[] }[];
    }[];
  };
  const lead = json.data?.[0];
  if (!lead) return null;
  const lower = email.toLowerCase();
  const contact =
    lead.contacts?.find((c) =>
      (c.emails ?? []).some((e) => e.email?.toLowerCase() === lower),
    ) ??
    lead.contacts?.[0] ??
    null;
  return { leadId: lead.id, contactId: contact?.id ?? null };
}

/** Find a Close lead by a contact phone number (E.164). Returns the lead id +
 *  the matching contact id (or the lead's first contact), or null. Used to
 *  attach an SMS activity to the right Close lead. */
export async function findCloseLeadByPhone(
  apiKey: string,
  phone: string,
): Promise<CloseLeadRef | null> {
  const q = `phone_number:"${phone.replace(/"/g, "")}"`;
  const res = await fetch(
    `${BASE}/lead/?query=${encodeURIComponent(q)}&_limit=1`,
    { headers: { Authorization: authHeader(apiKey) } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: {
      id: string;
      contacts?: { id: string; phones?: { phone?: string }[] }[];
    }[];
  };
  const lead = json.data?.[0];
  if (!lead) return null;
  const contact =
    lead.contacts?.find((c) =>
      (c.phones ?? []).some((p) => p.phone === phone),
    ) ??
    lead.contacts?.[0] ??
    null;
  return { leadId: lead.id, contactId: contact?.id ?? null };
}

/** Create a Close lead with a single contact + optional email (and phone if known).
 *  Returns the new lead/contact ids, or null on failure. */
export async function createCloseLead(
  apiKey: string,
  input: {
    companyName: string | null;
    contactName: string | null;
    email?: string | null;
    phone?: string | null;
  },
): Promise<CloseLeadRef | null> {
  const email = input.email?.trim() || null;
  const body = {
    name: input.companyName || input.contactName || email || "New lead",
    contacts: [
      {
        name: input.contactName || input.companyName || undefined,
        ...(email ? { emails: [{ email, type: "office" }] } : {}),
        ...(input.phone
          ? { phones: [{ phone: input.phone, type: "office" }] }
          : {}),
      },
    ],
  };
  const res = await fetch(`${BASE}/lead/`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    id: string;
    contacts?: { id: string }[];
  };
  return { leadId: json.id, contactId: json.contacts?.[0]?.id ?? null };
}

/** Post a plain-text Note activity onto a Close lead (POST /activity/note/).
 *  Returns the new activity id, or null on failure so the caller can surface a
 *  clear error instead of logging a half-completed handoff. */
export async function createCloseNote(
  apiKey: string,
  input: { closeLeadId: string; note: string },
): Promise<{ id: string } | null> {
  const res = await fetch(`${BASE}/activity/note/`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ lead_id: input.closeLeadId, note: input.note }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id?: string };
  return json.id ? { id: json.id } : null;
}

/** A connected account as Close returns it in the /connected_account/ list. */
export type CloseConnectedAccount = {
  id?: string;
  email?: string;
  send_status?: string;
  enabled_features?: string[];
};

/** Pick a connected account Close can actually SEND email from RIGHT NOW: the
 *  `email_sending` feature is enabled and the send channel is healthy
 *  (`send_status: "ok"`). Pure so the selection is unit-tested.
 *
 *  Why the strict check: a Gmail account connected for sync/reading only (no
 *  `email_sending` feature), or a reconnect still initializing (`send_status`
 *  not yet "ok"), CANNOT send — and picking it made Close reject the send with
 *  "No Connected Accounts were found to send this email" AFTER we'd already told
 *  the caller it sent. Returning null here routes the honest "I've made a note"
 *  fallback instead. */
export function pickSendingAccount(
  accounts: CloseConnectedAccount[],
): { id: string; email: string } | null {
  const acct = accounts.find(
    (a) =>
      a.id &&
      a.email &&
      a.send_status === "ok" &&
      (a.enabled_features?.includes("email_sending") ?? false),
  );
  return acct?.id && acct.email ? { id: acct.id, email: acct.email } : null;
}

/** The connected account Close will send FROM for this API key — its id AND
 *  address. The id must be passed as `email_account_id` on the outbox email or
 *  Close can't route the send. Returns null when no send-capable account exists. */
export async function closeSendingAccount(
  apiKey: string,
): Promise<{ id: string; email: string } | null> {
  const res = await fetch(`${BASE}/connected_account/`, {
    headers: { Authorization: authHeader(apiKey) },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: CloseConnectedAccount[] };
  return pickSendingAccount(json.data ?? []);
}

/** Send an email through Close (`status: "outbox"` → Close delivers it via the
 *  connected sending account). `emailAccountId` names WHICH connected account
 *  sends it — required, or Close fails the activity with "No Connected Accounts
 *  were found to send this email" even when a capable account exists. Returns
 *  the new activity id, or an error string the caller can surface. */
export async function sendCloseEmail(
  apiKey: string,
  input: {
    leadId: string;
    contactId: string | null;
    to: string;
    subject: string;
    bodyText: string;
    sender: string;
    emailAccountId: string;
  },
): Promise<{ id: string | null; error: string | null }> {
  const body = {
    lead_id: input.leadId,
    contact_id: input.contactId ?? undefined,
    to: [input.to],
    sender: input.sender,
    subject: input.subject,
    body_text: input.bodyText,
    status: "outbox",
    email_account_id: input.emailAccountId,
  };
  const res = await fetch(`${BASE}/activity/email/`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json()).slice(0, 200);
    } catch {
      /* non-JSON error body */
    }
    return {
      id: null,
      error: `Close returned ${res.status}. ${detail}`.trim(),
    };
  }
  const json = (await res.json()) as { id?: string };
  return { id: json.id ?? null, error: null };
}

/** Send an SMS through Close (`POST /activity/sms/`, `status:"outbox"` → Close
 *  delivers it). `localPhone` must be a Close SMS-enabled "internal" number.
 *  Returns the new activity id, or an error string the caller can surface. */
export async function sendCloseSms(
  apiKey: string,
  input: {
    leadId: string;
    contactId: string | null;
    localPhone: string;
    remotePhone: string;
    text: string;
  },
): Promise<{ id: string | null; error: string | null }> {
  const body = {
    lead_id: input.leadId,
    contact_id: input.contactId ?? undefined,
    local_phone: input.localPhone,
    remote_phone: input.remotePhone,
    text: input.text,
    status: "outbox",
  };
  const res = await fetch(`${BASE}/activity/sms/`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = JSON.stringify(await res.json()).slice(0, 200);
    } catch {
      /* non-JSON error body */
    }
    return {
      id: null,
      error: `Close returned ${res.status}. ${detail}`.trim(),
    };
  }
  const json = (await res.json()) as { id?: string };
  return { id: json.id ?? null, error: null };
}

/** Find a Close USER by email — used to assign a task to the appointment's host.
 *  GET /user/ lists the org's users; match by email case-insensitively. Returns
 *  the user id, or null when there is no match / the request fails. */
export async function findCloseUserByEmail(
  apiKey: string,
  email: string,
): Promise<{ id: string } | null> {
  // _limit=200 (Close's max page size) so the match works for any realistic
  // sales-team size without implementing full cursor pagination.
  const res = await fetch(`${BASE}/user/?_limit=200`, {
    headers: { Authorization: authHeader(apiKey) },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: { id: string; email?: string }[];
  };
  const lower = email.trim().toLowerCase();
  const user = (json.data ?? []).find((u) => u.email?.toLowerCase() === lower);
  return user ? { id: user.id } : null;
}

/** The Close user that owns this API key (GET /me/) — the fallback task assignee.
 *  Returns the user id, or null on failure. */
export async function getCloseMe(
  apiKey: string,
): Promise<{ id: string } | null> {
  const res = await fetch(`${BASE}/me/`, {
    headers: { Authorization: authHeader(apiKey) },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id?: string };
  return json.id ? { id: json.id } : null;
}

/** Create a Task on a Close lead (POST /task/), which appears in the assignee's
 *  Inbox. `assignedTo` (a Close user id) omitted → unassigned. `dueDate` is a
 *  YYYY-MM-DD string. Returns the task id, or null on failure. */
export async function createCloseTask(
  apiKey: string,
  input: {
    closeLeadId: string;
    text: string;
    assignedTo?: string | null;
    dueDate: string;
  },
): Promise<{ id: string } | null> {
  const body: Record<string, unknown> = {
    lead_id: input.closeLeadId,
    text: input.text,
    date: input.dueDate,
    is_complete: false,
  };
  if (input.assignedTo) body.assigned_to = input.assignedTo;
  const res = await fetch(`${BASE}/task/`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id?: string };
  return json.id ? { id: json.id } : null;
}

/** Ensure the org has lead custom-field definitions for `names` — GET the lead
 *  custom fields, create any missing ones (type "text"). Returns a name→field-id
 *  map. Best-effort: silently omits any it couldn't list or create. Used to stamp
 *  UTM attribution onto a handed-off lead. */
export async function ensureCloseLeadCustomFields(
  apiKey: string,
  names: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const res = await fetch(`${BASE}/custom_field/lead/?_limit=200`, {
    headers: { Authorization: authHeader(apiKey) },
  });
  const existing = res.ok
    ? (((await res.json()) as { data?: { id: string; name?: string }[] })
        .data ?? [])
    : [];
  const byName = new Map(
    existing.map((f) => [(f.name ?? "").toLowerCase(), f.id] as const),
  );
  for (const name of names) {
    const found = byName.get(name.toLowerCase());
    if (found) {
      out[name] = found;
      continue;
    }
    const cr = await fetch(`${BASE}/custom_field/lead/`, {
      method: "POST",
      headers: {
        Authorization: authHeader(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, type: "text" }),
    });
    if (cr.ok) {
      const j = (await cr.json()) as { id?: string };
      if (j.id) out[name] = j.id;
    }
  }
  return out;
}

/** Set lead custom-field values on a Close lead — PUT /lead/{id}/ with
 *  `custom.<field_id>` keys. Returns true on success. */
export async function setCloseLeadCustomFields(
  apiKey: string,
  closeLeadId: string,
  values: { fieldId: string; value: string }[],
): Promise<boolean> {
  if (values.length === 0) return true;
  const body: Record<string, unknown> = {};
  for (const v of values) body[`custom.${v.fieldId}`] = v.value;
  const res = await fetch(`${BASE}/lead/${closeLeadId}/`, {
    method: "PUT",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}
