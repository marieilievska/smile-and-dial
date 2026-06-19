// One-time backfill of the Hot Leads sell list from existing "yes" calls.
// Mirrors src/lib/agent-analytics/hot-leads.ts seedHotLeadFromCall exactly.
// Idempotent: POSTs with on_conflict=call_id + Prefer resolution=ignore-
// duplicates, so re-running never clobbers team edits. Reads .env.local.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")];
    }),
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const TZ = "America/New_York";
const etDate = (iso) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));
const pick = (ed, k) =>
  typeof ed?.[k] === "string" && ed[k].trim() ? ed[k].trim() : null;

const res = await fetch(
  `${URL_}/rest/v1/calls?select=id,lead_id,started_at,duration_seconds,extracted_data&extracted_data->>ai_call_answering_interest=eq.yes`,
  { headers: H },
);
const calls = await res.json();
console.log(`Fetched ${calls.length} yes-interest calls.`);

const rows = calls.map((c) => {
  const ed = c.extracted_data ?? {};
  return {
    call_id: c.id,
    lead_id: c.lead_id,
    session_date: c.started_at ? etDate(c.started_at) : null,
    contact_name:
      pick(ed, "owner_name") ??
      pick(ed, "manager_name") ??
      pick(ed, "employee_name"),
    why_hot: pick(ed, "ai_call_answering_reason"),
    call_length_seconds: c.duration_seconds ?? null,
    interest: "yes",
    current_ai_tool: pick(ed, "current_ai_tools"),
  };
});

const ins = await fetch(`${URL_}/rest/v1/hot_leads?on_conflict=call_id`, {
  method: "POST",
  headers: {
    ...H,
    "Content-Type": "application/json",
    Prefer: "resolution=ignore-duplicates,return=representation",
  },
  body: JSON.stringify(rows),
});
const out = await ins.json();
if (!ins.ok) {
  console.error("Insert failed:", ins.status, out);
  process.exit(1);
}
console.log(`Upserted. hot_leads now affected: ${out.length} rows.`);
