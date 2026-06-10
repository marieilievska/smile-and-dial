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
import { phoneToTimezone, stateFromPhone, stateToTimezone } from "./timezone";
import { isLookupLive, lookupLineType, toE164UsCa } from "./twilio-lookup";

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
 * estimated cost is $0. Skipping the lookup means mobile numbers are
 * NOT detected or filtered at any later point — there is no runtime
 * line-type gate — so they may be imported and dialed. Run the lookup
 * if you want mobiles flagged.
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
  const skipped: { phone: string; reason: string }[] = [];
  let importable = 0;
  let mobile = 0;
  let invalid = 0;

  // Normalize each row's phone to E.164 first — CSV phones are often
  // "(205) 259-8928" with no country code, which Twilio Lookup can't take.
  // A null means there's nothing to look up (import as-is, line type unknown).
  const e164s = input.rows.map((row) => {
    const raw = phoneHeader ? (row[phoneHeader] ?? "").trim() : "";
    return toE164UsCa(raw);
  });

  // Run the Twilio lookups CONCURRENTLY with a bounded pool. Sequential
  // lookups (one await per row) made large imports time the function out; a
  // pool keeps each batch fast while staying well under Twilio's rate limit.
  // Results are written back by index so rowLineTypes stays aligned to rows.
  const rowLineTypes: LineType[] = new Array(input.rows.length).fill("unknown");
  const CONCURRENCY = 15;
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= e164s.length) return;
      const phone = e164s[i];
      if (!phone) continue; // no phone → leave "unknown"
      rowLineTypes[i] = await lookupLineType(phone);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, input.rows.length) }, worker),
  );

  const lookups = e164s.filter(Boolean).length;
  e164s.forEach((phone, i) => {
    const lineType = rowLineTypes[i];
    if (!phone) {
      importable++;
    } else if (lineType === "mobile") {
      mobile++;
      skipped.push({ phone, reason: "Mobile number (TCPA compliance)" });
    } else if (lineType === "invalid") {
      invalid++;
      skipped.push({ phone, reason: "Invalid or disconnected number" });
    } else {
      importable++;
    }
  });

  const estCost = lookups * COST_PER_LOOKUP;

  // Record the lookup spend so it shows on the Costs page. Lookups are billed
  // by Twilio here, at analysis time (not during a call), so there's no call
  // row to hang the cost on — we log it to the lookup_charges ledger instead.
  // Only when live (mock lookups are free) and only when lookups actually ran.
  if (isLookupLive() && lookups > 0) {
    await supabase.from("lookup_charges").insert({
      owner_id: user.id,
      lookups,
      cost: estCost,
      source: "import",
    });
  }

  return {
    total: input.rows.length,
    importable,
    mobile,
    invalid,
    estCost,
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
    revived: 0,
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

  // Existing phone numbers, for deduplication. Includes soft-deleted leads:
  // the (owner_id, business_phone) unique constraint covers deleted rows too,
  // so a deleted lead still owns its phone slot. We track whether each match
  // is deleted so we can REVIVE it (below) instead of either skipping it as a
  // duplicate (which would make delete-then-reimport a no-op) or trying to
  // insert a fresh row (which the unique constraint would reject).
  // Collect the E.164 phones present in THIS batch so we only fetch the
  // existing leads that could actually collide. Fetching every owned lead
  // instead (a) is needless work and (b) silently hit PostgREST's 1000-row
  // cap, which broke dedup once a workspace passed 1000 leads.
  const phoneFieldHeader = [...headerToField.entries()].find(
    ([, key]) => key === "business_phone",
  )?.[0];
  const batchPhones = new Set<string>();
  if (phoneFieldHeader) {
    for (const row of input.rows) {
      const e164 = toE164UsCa((row[phoneFieldHeader] ?? "").trim());
      if (e164) batchPhones.add(e164);
    }
  }
  let existingQuery = supabase
    .from("leads")
    .select("id, business_phone, deleted_at")
    .eq("owner_id", user.id)
    .not("business_phone", "is", null);
  if (batchPhones.size > 0) {
    existingQuery = existingQuery.in("business_phone", [...batchPhones]);
  }
  const { data: existing } = await existingQuery;
  // Key by the normalized (E.164) phone so a match is found regardless of how
  // each side was formatted — e.g. a stored "(205) 259-8928" matches an
  // incoming "+12052598928". Falls back to the raw value for non-US numbers.
  const phoneToLead = new Map<string, { id: string; deleted: boolean }>();
  for (const lead of existing ?? []) {
    if (lead.business_phone) {
      const key = toE164UsCa(lead.business_phone) ?? lead.business_phone;
      phoneToLead.set(key, {
        id: lead.id,
        deleted: lead.deleted_at != null,
      });
    }
  }

  const seen = new Set<string>();
  const newLeads: Record<string, unknown>[] = [];
  const newCustoms: { customId: string; value: string }[][] = [];
  const updates: {
    leadId: string;
    fields: Record<string, unknown>;
    customs: { customId: string; value: string }[];
  }[] = [];
  // Soft-deleted matches: bring them back rather than skip/insert.
  const revives: {
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
    // Timezone for calling-hours. Primary signal is the state; if there's no
    // state, fall back to the phone's area code — which maps to a state and
    // thus a timezone — and backfill the state too so the lead isn't blank.
    const phoneRaw =
      typeof fields.business_phone === "string" ? fields.business_phone : "";
    if (typeof fields.state === "string" && fields.state.trim()) {
      if (!fields.timezone) {
        const tz = stateToTimezone(fields.state);
        if (tz) fields.timezone = tz;
      }
    } else if (phoneRaw) {
      const st = stateFromPhone(phoneRaw);
      if (st && !fields.state) fields.state = st;
      // Resolve the timezone straight from the area code so split-state codes
      // (915 El Paso -> Denver, 850 Pensacola -> Chicago) get the right zone
      // rather than the state's single default.
      if (!fields.timezone) {
        const tz = phoneToTimezone(phoneRaw);
        if (tz) fields.timezone = tz;
      }
    }
    // Store the phone in E.164 so it's dialable by Twilio and dedups
    // consistently. Leave non-US/CA numbers untouched.
    if (typeof fields.business_phone === "string") {
      const e164 = toE164UsCa(fields.business_phone);
      if (e164) fields.business_phone = e164;
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
      const match = phoneToLead.get(phone);
      if (match) {
        if (match.deleted) {
          // Revive a previously-deleted lead — clear deleted_at, refresh its
          // fields, and move it into the chosen list. Always happens (both
          // dedup modes), since a deleted lead isn't a live duplicate.
          revives.push({ leadId: match.id, fields, customs });
          return;
        }
        if (input.dedup === "skip") {
          skipped++;
          return;
        }
        updates.push({ leadId: match.id, fields, customs });
        return;
      }
    }

    newLeads.push({ ...fields, owner_id: user.id, list_id: input.listId });
    newCustoms.push(customs);
  });

  let revived = 0;
  const failTail = { revived, skipped, skippedMobile, skippedInvalid };

  // Insert new leads in batches. We UPSERT with ignoreDuplicates rather than a
  // plain INSERT so a row that already owns its (owner_id, business_phone) slot
  // is silently skipped instead of aborting the whole atomic batch. This
  // matters for rows whose phone couldn't be normalized to E.164: they're
  // stored with the raw string and bypass the dedup pre-fetch above (which only
  // collects parseable phones), so on a re-import they'd otherwise collide with
  // the (owner_id, business_phone) unique constraint and fail all 500 rows.
  // A skipped duplicate counts toward `skipped`, not `imported`.
  let imported = 0;
  for (let i = 0; i < newLeads.length; i += INSERT_BATCH) {
    const batch = newLeads.slice(i, i + INSERT_BATCH);
    const { data: inserted, error } = await supabase
      .from("leads")
      .upsert(batch as LeadInsert[], {
        onConflict: "owner_id,business_phone",
        ignoreDuplicates: true,
      })
      .select("id, business_phone");
    if (error || !inserted) {
      return {
        ...failTail,
        imported,
        updated: 0,
        error: "Some rows could not be imported.",
      };
    }
    imported += inserted.length;
    // Conflicting rows are NOT returned by an ignoreDuplicates upsert, so they
    // were silently skipped — count them as dedup skips so the wizard's
    // imported/skipped totals stay honest.
    skipped += batch.length - inserted.length;

    // The returned rows omit the skipped duplicates and aren't guaranteed to
    // be index-aligned with `batch`, so map each inserted lead back to its
    // batch row by phone to attach the right custom values. Rows with no phone
    // can't be matched this way, but they also can't collide on the unique
    // constraint, so they're always inserted and aligned 1:1 in input order;
    // we handle them positionally as a fallback.
    const customRows: {
      lead_id: string;
      custom_field_id: string;
      value: string;
    }[] = [];
    const idByPhone = new Map<string, string>();
    for (const lead of inserted) {
      if (lead.business_phone) idByPhone.set(lead.business_phone, lead.id);
    }
    const phonelessIds = inserted
      .filter((lead) => !lead.business_phone)
      .map((lead) => lead.id);
    let phonelessCursor = 0;
    batch.forEach((row, j) => {
      const customs = newCustoms[i + j];
      if (customs.length === 0) return;
      const phone =
        typeof row.business_phone === "string" ? row.business_phone : "";
      const leadId = phone
        ? idByPhone.get(phone)
        : phonelessIds[phonelessCursor++];
      if (!leadId) return; // skipped duplicate — nothing to attach
      for (const c of customs) {
        customRows.push({
          lead_id: leadId,
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

  // Revive soft-deleted matches: clear deleted_at, refresh fields, and move
  // them into the chosen list so they reappear on the Leads page.
  for (const r of revives) {
    const { error } = await supabase
      .from("leads")
      .update({
        ...r.fields,
        deleted_at: null,
        list_id: input.listId,
      } as LeadUpdate)
      .eq("id", r.leadId);
    if (!error) {
      revived++;
      if (r.customs.length > 0) {
        await supabase.from("lead_custom_values").upsert(
          r.customs.map((c) => ({
            lead_id: r.leadId,
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
    revived,
    updated,
    skipped,
    skippedMobile,
    skippedInvalid,
    error: null,
  };
}
