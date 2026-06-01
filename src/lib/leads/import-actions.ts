"use server";

import { revalidatePath } from "next/cache";

import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

import {
  COST_PER_LOOKUP,
  IMPORTABLE_FIELDS,
  type ImportAnalysis,
  type ImportResult,
  type LineType,
} from "./import-fields";
import { stateToTimezone } from "./timezone";
import { isUsCaNumber, lookupLineType } from "./twilio-lookup";

type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

const FIELD_KEYS = new Set<string>(IMPORTABLE_FIELDS.map((f) => f.key));
const NUMERIC_FIELDS = new Set(["google_rating", "google_reviews"]);
const INSERT_BATCH = 500;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Find the CSV header that the user mapped to the business_phone field. */
function phoneHeaderFrom(mapping: Record<string, string>): string {
  for (const [header, target] of Object.entries(mapping)) {
    if (target === "field:business_phone") return header;
  }
  return "";
}

/**
 * Run a Twilio Lookup on every row's business phone and report how many
 * leads will import versus be skipped (mobile numbers for TCPA compliance,
 * or invalid/disconnected numbers). Shown to the user before they commit.
 *
 * Set `skipLookup` to true to bypass Twilio entirely — all rows pass
 * through as importable, line types come back as "unknown", and the
 * estimated cost is $0. The runtime pre-call check still protects
 * against dialing mobile numbers later; this only opts out of import-
 * time verification.
 */
export async function analyzeImport(input: {
  mapping: Record<string, string>;
  rows: Record<string, string>[];
  skipLookup?: boolean;
}): Promise<ImportAnalysis> {
  const empty: ImportAnalysis = {
    total: input.rows.length,
    importable: 0,
    mobile: 0,
    invalid: 0,
    estCost: 0,
    rowLineTypes: [],
    skipped: [],
    error: null,
  };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ...empty, error: "You are not signed in." };

  // Fast path: user opted out of Twilio verification — every row goes
  // through as importable with an "unknown" line type and zero cost.
  if (input.skipLookup) {
    return {
      total: input.rows.length,
      importable: input.rows.length,
      mobile: 0,
      invalid: 0,
      estCost: 0,
      rowLineTypes: input.rows.map(() => "unknown" as LineType),
      skipped: [],
      error: null,
    };
  }

  const phoneHeader = phoneHeaderFrom(input.mapping);
  const rowLineTypes: LineType[] = [];
  const skipped: { phone: string; reason: string }[] = [];
  let importable = 0;
  let mobile = 0;
  let invalid = 0;
  let lookups = 0;

  for (const row of input.rows) {
    const phone = phoneHeader ? (row[phoneHeader] ?? "").trim() : "";

    // No phone, or a number outside US/CA: nothing to look up, import as-is.
    if (!phone || !isUsCaNumber(phone)) {
      rowLineTypes.push("unknown");
      importable++;
      continue;
    }

    lookups++;
    const lineType = await lookupLineType(phone);
    rowLineTypes.push(lineType);

    if (lineType === "mobile") {
      mobile++;
      skipped.push({ phone, reason: "Mobile number (TCPA compliance)" });
    } else if (lineType === "invalid") {
      invalid++;
      skipped.push({ phone, reason: "Invalid or disconnected number" });
    } else {
      importable++;
    }
  }

  return {
    total: input.rows.length,
    importable,
    mobile,
    invalid,
    estCost: lookups * COST_PER_LOOKUP,
    rowLineTypes,
    skipped,
    error: null,
  };
}

/**
 * Import leads from parsed CSV rows. `mapping` maps each CSV header to one of:
 * "field:<leadField>", "custom:<customFieldId>", "newcustom", or "skip".
 *
 * `rowLineTypes` (from `analyzeImport`, aligned by index) lets the import skip
 * mobile and invalid numbers without paying for a second round of lookups.
 */
export async function importLeads(input: {
  listId: string;
  dedup: "skip" | "update";
  mapping: Record<string, string>;
  rows: Record<string, string>[];
  rowLineTypes?: LineType[];
}): Promise<ImportResult> {
  const base = {
    imported: 0,
    updated: 0,
    skipped: 0,
    skippedMobile: 0,
    skippedInvalid: 0,
  };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ...base, error: "You are not signed in." };

  const { data: list } = await supabase
    .from("lists")
    .select("id")
    .eq("id", input.listId)
    .maybeSingle();
  if (!list) return { ...base, error: "Choose a valid list to import into." };

  // Creating a NEW custom field requires admin (RLS on custom_field_defs).
  // Catch this BEFORE inserting any leads so a non-admin doesn't get a
  // confusing mid-flow "Could not create a custom field" after some rows
  // may already exist. We only need to create a field for headers mapped to
  // "newcustom" whose slug doesn't already exist — but checking the role
  // up front and giving a clear, actionable message is simpler and safer.
  const wantsNewCustom = Object.values(input.mapping).some(
    (t) => t === "newcustom",
  );
  if (wantsNewCustom) {
    const { data: me } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (me?.role !== "admin") {
      return {
        ...base,
        error:
          "Creating a new custom field needs an admin. Ask an admin to add the field under Settings → Custom fields, then map your column to it — or remove the new-field columns and import the rest.",
      };
    }
  }

  // Resolve custom-field columns: create new fields, reuse existing ones.
  const headerToCustomId = new Map<string, string>();
  for (const [header, target] of Object.entries(input.mapping)) {
    if (target.startsWith("custom:")) {
      headerToCustomId.set(header, target.slice(7));
    } else if (target === "newcustom") {
      const slug = slugify(header);
      if (!slug) continue;
      const { data: existing } = await supabase
        .from("custom_field_defs")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();
      if (existing) {
        headerToCustomId.set(header, existing.id);
        continue;
      }
      const { count } = await supabase
        .from("custom_field_defs")
        .select("id", { count: "exact", head: true });
      const { data: created, error } = await supabase
        .from("custom_field_defs")
        .insert({
          name: header,
          slug,
          type: "text",
          sort_order: count ?? 0,
        })
        .select("id")
        .single();
      if (error || !created) {
        return { ...base, error: "Could not create a custom field." };
      }
      headerToCustomId.set(header, created.id);
    }
  }

  const headerToField = new Map<string, string>();
  for (const [header, target] of Object.entries(input.mapping)) {
    if (target.startsWith("field:")) {
      const key = target.slice(6);
      if (FIELD_KEYS.has(key)) headerToField.set(header, key);
    }
  }

  // Existing phone numbers, for deduplication.
  const { data: existing } = await supabase
    .from("leads")
    .select("id, business_phone")
    .eq("owner_id", user.id)
    .not("business_phone", "is", null);
  const phoneToLeadId = new Map<string, string>();
  for (const lead of existing ?? []) {
    if (lead.business_phone) phoneToLeadId.set(lead.business_phone, lead.id);
  }

  const seen = new Set<string>();
  const newLeads: Record<string, unknown>[] = [];
  const newCustoms: { customId: string; value: string }[][] = [];
  const updates: {
    leadId: string;
    fields: Record<string, unknown>;
    customs: { customId: string; value: string }[];
  }[] = [];
  let skipped = 0;
  let skippedMobile = 0;
  let skippedInvalid = 0;

  input.rows.forEach((row, index) => {
    // Drop mobile and invalid numbers flagged by the Twilio Lookup analysis.
    const lineType = input.rowLineTypes?.[index];
    if (lineType === "mobile") {
      skippedMobile++;
      return;
    }
    if (lineType === "invalid") {
      skippedInvalid++;
      return;
    }

    const fields: Record<string, unknown> = {};
    for (const [header, key] of headerToField) {
      const raw = (row[header] ?? "").trim();
      if (!raw) continue;
      if (NUMERIC_FIELDS.has(key)) {
        const n = Number(raw);
        if (!Number.isNaN(n)) fields[key] = n;
      } else {
        fields[key] = raw;
      }
    }
    if (typeof fields.state === "string" && !fields.timezone) {
      const tz = stateToTimezone(fields.state);
      if (tz) fields.timezone = tz;
    }

    const customs: { customId: string; value: string }[] = [];
    for (const [header, customId] of headerToCustomId) {
      const raw = (row[header] ?? "").trim();
      if (raw) customs.push({ customId, value: raw });
    }

    const phone =
      typeof fields.business_phone === "string" ? fields.business_phone : "";
    if (phone) {
      if (seen.has(phone)) {
        skipped++;
        return;
      }
      seen.add(phone);
      const existingId = phoneToLeadId.get(phone);
      if (existingId) {
        if (input.dedup === "skip") {
          skipped++;
          return;
        }
        updates.push({ leadId: existingId, fields, customs });
        return;
      }
    }

    newLeads.push({ ...fields, owner_id: user.id, list_id: input.listId });
    newCustoms.push(customs);
  });

  const failTail = { skipped, skippedMobile, skippedInvalid };

  // Insert new leads in batches, keeping the returned ids aligned by index.
  let imported = 0;
  for (let i = 0; i < newLeads.length; i += INSERT_BATCH) {
    const batch = newLeads.slice(i, i + INSERT_BATCH);
    const { data: inserted, error } = await supabase
      .from("leads")
      .insert(batch as LeadInsert[])
      .select("id");
    if (error || !inserted) {
      return {
        ...failTail,
        imported,
        updated: 0,
        error: "Some rows could not be imported.",
      };
    }
    imported += inserted.length;

    const customRows: {
      lead_id: string;
      custom_field_id: string;
      value: string;
    }[] = [];
    inserted.forEach((lead, j) => {
      for (const c of newCustoms[i + j]) {
        customRows.push({
          lead_id: lead.id,
          custom_field_id: c.customId,
          value: c.value,
        });
      }
    });
    if (customRows.length > 0) {
      await supabase.from("lead_custom_values").insert(customRows);
    }
  }

  // Apply updates for matched leads.
  let updated = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from("leads")
      .update(u.fields as LeadUpdate)
      .eq("id", u.leadId);
    if (!error) {
      updated++;
      if (u.customs.length > 0) {
        await supabase.from("lead_custom_values").upsert(
          u.customs.map((c) => ({
            lead_id: u.leadId,
            custom_field_id: c.customId,
            value: c.value,
          })),
        );
      }
    }
  }

  revalidatePath("/leads");
  return {
    imported,
    updated,
    skipped,
    skippedMobile,
    skippedInvalid,
    error: null,
  };
}
