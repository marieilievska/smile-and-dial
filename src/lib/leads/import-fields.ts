import { twilioLookupUsd } from "@/lib/costs/rates";

/** Lead fields a CSV column can be mapped to during import. */
export const IMPORTABLE_FIELDS = [
  { key: "company", label: "Company" },
  { key: "business_phone", label: "Business phone" },
  { key: "business_email", label: "Business email" },
  { key: "owner_name", label: "Owner name" },
  { key: "owner_phone", label: "Owner phone" },
  { key: "manager_name", label: "Manager name" },
  { key: "employee_name", label: "Employee name" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "website", label: "Website" },
  { key: "category", label: "Category" },
  { key: "google_place_id", label: "Google place ID" },
  { key: "google_rating", label: "Google rating" },
  { key: "google_reviews", label: "Google reviews" },
] as const;

/** Twilio Lookup line-type classification for a phone number. */
export type LineType = "landline" | "mobile" | "voip" | "invalid" | "unknown";

/** Cost charged by Twilio for one Line Type Intelligence lookup, in USD.
 *  Sourced from the central rates module (env-overridable). */
export const COST_PER_LOOKUP = twilioLookupUsd();

export type ImportResult = {
  imported: number;
  /** Leads that existed but had been deleted, brought back to life by this
   *  import (deleted_at cleared, fields refreshed, moved to the chosen list). */
  revived: number;
  updated: number;
  skipped: number;
  skippedMobile: number;
  skippedInvalid: number;
  error: string | null;
};

/**
 * Pre-commit analysis of a CSV: how many rows will import, how many are
 * skipped (and why), and the estimated Twilio Lookup cost.
 */
export type ImportAnalysis = {
  total: number;
  importable: number;
  mobile: number;
  invalid: number;
  /** Rows whose number already belongs to a live (non-deleted) lead you own —
   *  these won't create a new lead. On commit they're skipped (Skip mode) or
   *  refreshed in place (Update mode), never duplicated. */
  duplicateExisting: number;
  /** Rows whose number repeats an earlier row in the same file — only the first
   *  occurrence imports; the rest collapse into it. */
  duplicateInFile: number;
  estCost: number;
  /** Line type per row, aligned to the rows array by index. */
  rowLineTypes: LineType[];
  /** Skipped rows, for the downloadable error report. */
  skipped: { phone: string; reason: string }[];
  error: string | null;
};
