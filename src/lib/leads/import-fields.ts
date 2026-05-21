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

export type ImportResult = {
  imported: number;
  updated: number;
  skipped: number;
  error: string | null;
};
