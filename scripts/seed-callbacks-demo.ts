/**
 * One-off seed / cleanup script for the Callbacks page visual review.
 *
 *   npx tsx scripts/seed-callbacks-demo.ts          # seed 4 demo rows
 *   npx tsx scripts/seed-callbacks-demo.ts cleanup  # remove them
 *
 * Inserts four callbacks with varied scheduled_at times so the round-9
 * redesign can be screenshotted in a populated state:
 *
 *   - Overdue by 2 hours (red urgency rail)
 *   - Due in 25 minutes  (coral urgency rail)
 *   - Due tomorrow morning
 *   - Due in 5 days
 *
 * Idempotent: companies are tagged with `DEMO-CB-` so re-runs replace
 * the same rows. Pass "cleanup" to remove them entirely.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const TAG = "DEMO-CB";

async function clearExisting() {
  const prev = await supabase
    .from("leads")
    .select("id")
    .like("company", `${TAG}-%`);
  if (prev.data && prev.data.length > 0) {
    const ids = prev.data.map((l) => l.id);
    await supabase.from("callbacks").delete().in("lead_id", ids);
    await supabase.from("leads").delete().in("id", ids);
    console.log(`Removed ${ids.length} demo lead(s) and their callbacks.`);
  } else {
    console.log("Nothing to clean up.");
  }
}

async function seed() {
  const { data: owner } = await supabase
    .from("profiles")
    .select("id, email")
    .eq("role", "admin")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (!owner) throw new Error("No admin profile found.");
  console.log("Owner:", owner.email);

  let { data: list } = await supabase
    .from("lists")
    .select("id")
    .eq("owner_id", owner.id)
    .limit(1)
    .single();
  if (!list) {
    const created = await supabase
      .from("lists")
      .insert({ owner_id: owner.id, name: `${TAG}-list` })
      .select("id")
      .single();
    list = created.data!;
  }

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, name")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (!campaign) throw new Error("No campaign found.");

  await clearExisting();

  const now = Date.now();
  const scenarios: {
    suffix: string;
    scheduledAtMs: number;
    voicemail: number;
  }[] = [
    {
      suffix: "overdue",
      scheduledAtMs: now - 2 * 60 * 60 * 1000,
      voicemail: 1,
    },
    { suffix: "urgent", scheduledAtMs: now + 25 * 60 * 1000, voicemail: 0 },
    {
      suffix: "tomorrow",
      scheduledAtMs: now + 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000,
      voicemail: 2,
    },
    {
      suffix: "later",
      scheduledAtMs: now + 5 * 24 * 60 * 60 * 1000,
      voicemail: 0,
    },
  ];

  for (const [i, s] of scenarios.entries()) {
    const { data: lead } = await supabase
      .from("leads")
      .insert({
        owner_id: owner.id,
        list_id: list.id,
        company: `${TAG}-${s.suffix}`,
        business_phone: `+155500001${i}0`,
        status: "callback",
      })
      .select("id")
      .single();
    await supabase.from("callbacks").insert({
      lead_id: lead!.id,
      campaign_id: campaign.id,
      scheduled_at: new Date(s.scheduledAtMs).toISOString(),
      status: "pending",
      voicemail_attempts: s.voicemail,
    });
    console.log(
      `Seeded ${TAG}-${s.suffix} (scheduled ${new Date(s.scheduledAtMs).toLocaleString()})`,
    );
  }
  console.log("Done.");
}

const mode = process.argv[2] ?? "seed";
const run = mode === "cleanup" ? clearExisting : seed;
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
