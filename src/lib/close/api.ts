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

/** The email address Close will send FROM for this API key — the first
 *  connected email-capable account. Needed so an outbox email actually
 *  delivers. Returns null when no sending account is connected. */
export async function closeSenderEmail(apiKey: string): Promise<string | null> {
  const res = await fetch(`${BASE}/connected_account/`, {
    headers: { Authorization: authHeader(apiKey) },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: { _type?: string; email?: string }[];
  };
  const acct = (json.data ?? []).find(
    (a) =>
      a.email &&
      /google|gmail|email|smtp|office|microsoft|custom|outlook/i.test(
        a._type ?? "",
      ),
  );
  return acct?.email ?? null;
}

/** Send an email through Close (`status: "outbox"` → Close delivers it via the
 *  connected sending account). Returns the new activity id, or an error
 *  string the caller can surface. */
export async function sendCloseEmail(
  apiKey: string,
  input: {
    leadId: string;
    contactId: string | null;
    to: string;
    subject: string;
    bodyText: string;
    sender: string;
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
