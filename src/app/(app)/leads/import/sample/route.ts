import { redirect } from "next/navigation";

import { IMPORTABLE_FIELDS } from "@/lib/leads/import-fields";
import { createClient } from "@/lib/supabase/server";

/** Download a sample CSV the operator can fill in. Uses every importable
 *  field as the header row and 3 plausible example businesses as the
 *  data rows. The user fills in the rest and uploads via the wizard.
 *
 *  Sample data is intentionally generic ("ABC Fitness", phones in the
 *  555-prefix non-callable test range) — never real leads. */
const SAMPLE_ROWS: Record<string, string>[] = [
  {
    company: "ABC Fitness",
    business_phone: "+12125550101",
    business_email: "hello@abcfitness.example",
    owner_name: "Jamie Owens",
    owner_phone: "+12125550102",
    manager_name: "Casey Lee",
    employee_name: "Robin Park",
    city: "New York",
    state: "NY",
    website: "https://abcfitness.example",
    category: "Gym",
    google_place_id: "",
    google_rating: "4.5",
    google_reviews: "124",
  },
  {
    company: "Sunrise Yoga Studio",
    business_phone: "+13105550103",
    business_email: "hello@sunriseyoga.example",
    owner_name: "Morgan Avery",
    owner_phone: "+13105550104",
    manager_name: "",
    employee_name: "",
    city: "Santa Monica",
    state: "CA",
    website: "https://sunriseyoga.example",
    category: "Yoga studio",
    google_place_id: "",
    google_rating: "4.8",
    google_reviews: "201",
  },
  {
    company: "Crunch Downtown",
    business_phone: "+17735550105",
    business_email: "info@crunchdowntown.example",
    owner_name: "Pat Rivera",
    owner_phone: "",
    manager_name: "Sam Chen",
    employee_name: "",
    city: "Chicago",
    state: "IL",
    website: "https://crunchdowntown.example",
    category: "Gym",
    google_place_id: "",
    google_rating: "4.2",
    google_reviews: "89",
  },
];

function csvEscape(value: string): string {
  // RFC 4180-ish — wrap fields containing commas, quotes, or newlines
  // in double quotes and double any embedded quotes.
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function GET() {
  // Match the rest of /leads — gated by auth even though there's
  // nothing user-specific in the response.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const headers = IMPORTABLE_FIELDS.map((f) => f.key);
  const lines: string[] = [];
  lines.push(headers.map(csvEscape).join(","));
  for (const row of SAMPLE_ROWS) {
    lines.push(headers.map((key) => csvEscape(row[key] ?? "")).join(","));
  }

  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="smile-and-dial-sample-leads.csv"',
    },
  });
}
