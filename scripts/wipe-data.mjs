// One-off DESTRUCTIVE wipe. Mirrors the app's own delete logic (it removes the
// call recordings from Storage, which plain SQL can't). Requires --yes to run.
//
//   node scripts/wipe-data.mjs            # dry run: prints current counts only
//   node scripts/wipe-data.mjs --yes      # performs the deletion
//
// Deletes, in FK-safe order: call recordings (Storage) -> calls -> callbacks
// -> leads (cascades custom values/emails) -> campaigns (releases Twilio
// numbers) -> the DNC entry -> system_events.
// KEEPS: lookup_charges, goals (definitions), lists, agents, twilio_numbers,
// dnc_removals, and ElevenLabs (untouched).
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.argv.includes("--yes");

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

async function count(table) {
  const { count } = await admin
    .from(table)
    .select("id", { count: "exact", head: true });
  return count ?? 0;
}
async function report(label) {
  const tables = [
    "leads",
    "calls",
    "callbacks",
    "campaigns",
    "dnc_entries",
    "system_events",
    "goals",
    "lookup_charges",
    "lists",
  ];
  console.log(`\n=== ${label} ===`);
  for (const t of tables) console.log(`  ${t.padEnd(16)} ${await count(t)}`);
}

async function deleteAll(table) {
  // A real WHERE clause is required; id is a NOT NULL PK so this matches all.
  const { error } = await admin.from(table).delete().not("id", "is", null);
  if (error) throw new Error(`delete ${table}: ${error.message}`);
}

await report("BEFORE");
if (!LIVE) {
  console.log("\nDry run only. Re-run with --yes to perform the deletion.");
  process.exit(0);
}

// 1) Remove call recordings from the private Storage bucket (object paths only,
//    skipping any legacy http(s) URLs) -- mirrors removeCallRecordings().
const { data: recs } = await admin
  .from("calls")
  .select("recording_path")
  .limit(100000);
const objects = (recs ?? [])
  .map((r) => r.recording_path)
  .filter((p) => p && !/^https?:\/\//i.test(p));
for (let i = 0; i < objects.length; i += 100) {
  const batch = objects.slice(i, i + 100);
  const { error } = await admin.storage.from("call-recordings").remove(batch);
  if (error) console.warn(`  storage remove warn: ${error.message}`);
}
console.log(`Storage: removed ${objects.length} recording objects`);

// 2-7) Delete rows in FK-safe order.
await deleteAll("calls");
console.log("Deleted calls");
await deleteAll("callbacks");
console.log("Deleted callbacks");
await deleteAll("leads");
console.log("Deleted leads (custom values/emails cascade)");
await deleteAll("campaigns");
console.log("Deleted campaigns (Twilio numbers released)");
await deleteAll("dnc_entries");
console.log("Deleted DNC entries");
await deleteAll("system_events");
console.log("Deleted system events");

await report("AFTER");
console.log("\nDone.");
