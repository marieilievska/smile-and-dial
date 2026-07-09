// One-off READ-ONLY backup taken before the data wipe.
// Dumps every table the wipe will empty to local JSON files so the data is
// recoverable. Touches nothing in the database. Run: node scripts/backup-before-wipe.mjs
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

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(ROOT, "backups", `wipe-${stamp}`);
mkdirSync(outDir, { recursive: true });

// Every table the wipe will delete from (plus the kept ledgers, for safety).
const TABLES = [
  "leads",
  "lead_custom_values",
  "calls",
  "callbacks",
  "campaigns",
  "dnc_entries",
  "dnc_removals",
  "system_events",
  "emails",
  "goals",
  "lookup_charges",
  "lists",
];

async function fetchAll(table) {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await admin
      .from(table)
      .select("*")
      .range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < page) break;
  }
  return rows;
}

for (const table of TABLES) {
  const rows = await fetchAll(table);
  writeFileSync(join(outDir, `${table}.json`), JSON.stringify(rows, null, 2));
  console.log(`${table.padEnd(20)} ${rows.length} rows -> ${table}.json`);
}
console.log(`\nBackup written to: ${outDir}`);
