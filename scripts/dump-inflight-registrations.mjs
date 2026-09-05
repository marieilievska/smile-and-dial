// READ-ONLY. Dumps registrations whose webinar session is still in the FUTURE
// to a CSV in backups/, so the people a wipe is about to delete can still be
// reconciled by hand if one of them buys.
//
// The company name lives on the lead, which the wipe deletes, so it is copied
// into the CSV here rather than left as a dangling id.
//
//   node scripts/dump-inflight-registrations.mjs
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load .env.local without printing secrets.
const env = {};
for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(
  /\r?\n/,
)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
}
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: events, error } = await admin
  .from("calendly_events")
  .select(
    "lead_id, invitee_name, invitee_email, invitee_phone, scheduled_at, created_at, status",
  )
  .order("scheduled_at", { ascending: true });
if (error) throw new Error(error.message);

const now = Date.now();
const inflight = (events ?? []).filter(
  (e) =>
    e.status !== "canceled" &&
    e.scheduled_at &&
    new Date(e.scheduled_at).getTime() > now,
);

// Company name lives on the lead, which the wipe deletes — copy it in now.
const leadIds = [...new Set(inflight.map((e) => e.lead_id).filter(Boolean))];
const companies = new Map();
for (let i = 0; i < leadIds.length; i += 100) {
  const { data } = await admin
    .from("leads")
    .select("id, company")
    .in("id", leadIds.slice(i, i + 100));
  for (const l of data ?? []) companies.set(l.id, l.company);
}

const etDay = (iso) =>
  new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const etStamp = (iso) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York" });
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

const header = [
  "company",
  "name",
  "email",
  "phone",
  "dial_day_et",
  "session_et",
];
const lines = [header.join(",")];
for (const e of inflight) {
  lines.push(
    [
      companies.get(e.lead_id),
      e.invitee_name,
      e.invitee_email,
      e.invitee_phone,
      etDay(e.created_at),
      etStamp(e.scheduled_at),
    ]
      .map(csvCell)
      .join(","),
  );
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(ROOT, "backups");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `inflight-registrations-${stamp}.csv`);
writeFileSync(outPath, lines.join("\n"), "utf8");
console.log(`Wrote ${inflight.length} in-flight registrations to ${outPath}`);
