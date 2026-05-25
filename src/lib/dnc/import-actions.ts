"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type DncImportResult = {
  added: number;
  skippedDuplicate: number;
  skippedInvalid: number;
  error: string | null;
};

const INSERT_BATCH = 500;

// E.164: leading +, country digit 1–9, then up to 14 more digits.
const E164 = /^\+[1-9]\d{1,14}$/;

/**
 * Normalize a CSV phone cell into E.164. Strips spaces, parens, dashes, dots
 * and a leading "tel:" prefix; if there's no leading "+", a 10-digit string
 * gets a US "+1" prefix and an 11-digit string starting with "1" gets a "+".
 */
function normalizePhone(raw: string): string {
  let s = raw.trim().replace(/^tel:/i, "");
  if (!s) return "";
  // Keep "+" only if it's the first character.
  const hasPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (!s) return "";
  if (hasPlus) return `+${s}`;
  if (s.length === 10) return `+1${s}`;
  if (s.length === 11 && s.startsWith("1")) return `+${s}`;
  return ""; // Anything else: too ambiguous to guess a country code.
}

/**
 * Import phone numbers onto the workspace DNC list from a parsed CSV. The
 * caller picks which CSV header holds the phone (required) and optionally
 * which holds the company. Every inserted row is stamped `reason="imported"`
 * (per BUILD_PLAN Section 5.7). Already-on-DNC numbers are silently skipped.
 */
export async function importDnc(input: {
  phoneHeader: string;
  companyHeader: string;
  rows: Record<string, string>[];
}): Promise<DncImportResult> {
  const empty: DncImportResult = {
    added: 0,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    error: null,
  };

  if (!input.phoneHeader) {
    return { ...empty, error: "Pick which column holds the phone number." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ...empty, error: "You are not signed in." };

  // Build the candidate rows: validate, normalize, dedupe within the file.
  const seen = new Set<string>();
  const candidates: { phone: string; company: string | null }[] = [];
  let skippedInvalid = 0;
  let skippedDuplicate = 0;

  for (const row of input.rows) {
    const phone = normalizePhone(row[input.phoneHeader] ?? "");
    if (!phone || !E164.test(phone)) {
      skippedInvalid++;
      continue;
    }
    if (seen.has(phone)) {
      skippedDuplicate++;
      continue;
    }
    seen.add(phone);
    const company = input.companyHeader
      ? (row[input.companyHeader] ?? "").trim() || null
      : null;
    candidates.push({ phone, company });
  }

  if (candidates.length === 0) {
    return {
      added: 0,
      skippedDuplicate,
      skippedInvalid,
      error: null,
    };
  }

  // upsert with ignoreDuplicates so already-on-DNC numbers are skipped silently
  // and the rest still import. We need an accurate `added` count so we batch
  // and ask for the returned ids.
  let added = 0;
  for (let i = 0; i < candidates.length; i += INSERT_BATCH) {
    const batch = candidates.slice(i, i + INSERT_BATCH);
    const rows = batch.map((c) => ({
      phone: c.phone,
      company_snapshot: c.company,
      reason: "imported" as const,
      added_by_user_id: user.id,
    }));
    const { data, error } = await supabase
      .from("dnc_entries")
      .upsert(rows, { onConflict: "phone", ignoreDuplicates: true })
      .select("id");
    if (error) {
      return {
        added,
        skippedDuplicate,
        skippedInvalid,
        error: "Some numbers could not be imported.",
      };
    }
    added += data?.length ?? 0;
  }

  // Anything in the file that wasn't `added` and wasn't `skippedInvalid` is
  // an already-on-DNC duplicate the upsert skipped.
  skippedDuplicate += candidates.length - added;

  revalidatePath("/dnc");
  return {
    added,
    skippedDuplicate,
    skippedInvalid,
    error: null,
  };
}
