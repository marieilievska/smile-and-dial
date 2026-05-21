// Seeds a "Demo leads" list with sample leads so the Leads table can be
// reviewed before CSV import exists. Safe to delete the list afterwards.
//
//   node --env-file=.env.local scripts/seed-demo-leads.mjs

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing Supabase env vars.");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: owner } = await admin
  .from("profiles")
  .select("id")
  .eq("email", "marie@referrizer.com")
  .single();
if (!owner) {
  console.error("Could not find the marie@referrizer.com profile.");
  process.exit(1);
}

const { data: existing } = await admin
  .from("lists")
  .select("id")
  .eq("owner_id", owner.id)
  .eq("name", "Demo leads")
  .maybeSingle();
if (existing) {
  console.log("= Demo leads list already exists — nothing to do.");
  process.exit(0);
}

const { data: list, error: listError } = await admin
  .from("lists")
  .insert({
    owner_id: owner.id,
    name: "Demo leads",
    description: "Sample data for previewing the Leads table — safe to delete.",
  })
  .select("id")
  .single();
if (listError) {
  console.error(`Could not create the demo list: ${listError.message}`);
  process.exit(1);
}

const cities = [
  ["Austin", "TX"],
  ["Dallas", "TX"],
  ["Denver", "CO"],
  ["Reno", "NV"],
  ["Tampa", "FL"],
  ["Boise", "ID"],
];
const statuses = ["ready_to_call", "callback", "resting", "goal_met", "dnc"];

const leads = Array.from({ length: 30 }, (_, i) => {
  const [city, state] = cities[i % cities.length];
  return {
    owner_id: owner.id,
    list_id: list.id,
    company: `Demo Company ${String(i + 1).padStart(2, "0")}`,
    business_phone: `+1512555${String(1000 + i).padStart(4, "0")}`,
    business_email: `info${i + 1}@demo.example`,
    owner_name: `Owner ${i + 1}`,
    city,
    state,
    status: statuses[i % statuses.length],
    conversations: i % 4,
    call_attempts: i % 7,
  };
});

const { error } = await admin.from("leads").insert(leads);
if (error) {
  console.error(`Could not create demo leads: ${error.message}`);
  process.exit(1);
}

console.log(
  `+ Created the "Demo leads" list with ${leads.length} sample leads.`,
);
