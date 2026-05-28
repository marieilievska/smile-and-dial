import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

/** Sample CSV for the DNC importer. Header row matches what the
 *  wizard's auto-guess looks for ("phone" + "company") so a freshly
 *  downloaded sample maps without the user touching the dropdowns.
 *
 *  Numbers use the 555 non-callable test range so a sample never
 *  accidentally blocks a real phone if it survives into production. */
const SAMPLE_ROWS: { phone: string; company: string }[] = [
  { phone: "+12125550101", company: "ABC Fitness" },
  { phone: "+13105550103", company: "Sunrise Yoga Studio" },
  { phone: "+17735550105", company: "Crunch Downtown" },
];

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function GET() {
  // Gate behind auth — same pattern as the leads sample.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const lines: string[] = ["phone,company"];
  for (const row of SAMPLE_ROWS) {
    lines.push(`${csvEscape(row.phone)},${csvEscape(row.company)}`);
  }

  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="smile-and-dial-sample-dnc.csv"',
    },
  });
}
