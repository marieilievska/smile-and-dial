/**
 * One-off seed / cleanup for the Goals pipeline visual review.
 *
 *   npx tsx scripts/seed-pipeline-demo.ts          # seed
 *   npx tsx scripts/seed-pipeline-demo.ts cleanup  # remove
 *
 * Creates 6 leads with goal_met calls so each pipeline status has at
 * least one card on the board view:
 *  - Goal met (today)         × 2
 *  - Attended (3 days ago)    × 1
 *  - No show (5 days ago)     × 1
 *  - Sale (2 days ago)        × 1
 *  - Closed (3 weeks ago)     × 1  ← also exercises the "Stale" pill
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const TAG = "DEMO-PIPELINE";

async function clearExisting() {
  const prev = await supabase
    .from("leads")
    .select("id")
    .like("company", `${TAG}-%`);
  if (prev.data && prev.data.length > 0) {
    const ids = prev.data.map((l) => l.id);
    await supabase.from("calls").delete().in("lead_id", ids);
    await supabase.from("leads").delete().in("id", ids);
    console.log(`Removed ${ids.length} demo lead(s) and their calls.`);
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
    .select("id, name, agent_id, twilio_number_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (!campaign) throw new Error("No campaign found.");

  await clearExisting();

  type Scenario = {
    suffix: string;
    status: "goal_met" | "attended" | "no_show" | "sale" | "closed";
    daysAgo: number;
  };
  const scenarios: Scenario[] = [
    { suffix: "goal-met-1", status: "goal_met", daysAgo: 0 },
    { suffix: "goal-met-2", status: "goal_met", daysAgo: 1 },
    { suffix: "attended", status: "attended", daysAgo: 3 },
    { suffix: "no-show", status: "no_show", daysAgo: 5 },
    { suffix: "sale", status: "sale", daysAgo: 2 },
    { suffix: "closed-stale", status: "closed", daysAgo: 21 },
  ];

  for (const [i, s] of scenarios.entries()) {
    const { data: lead } = await supabase
      .from("leads")
      .insert({
        owner_id: owner.id,
        list_id: list.id,
        company: `${TAG}-${s.suffix}`,
        business_phone: `+155500002${String(i).padStart(2, "0")}`,
        status: s.status,
        last_call_at: new Date(
          Date.now() - s.daysAgo * 86_400_000,
        ).toISOString(),
      })
      .select("id")
      .single();
    const goalMetAt = new Date(
      Date.now() - s.daysAgo * 86_400_000,
    ).toISOString();
    await supabase.from("calls").insert({
      lead_id: lead!.id,
      campaign_id: campaign.id,
      agent_id: campaign.agent_id,
      twilio_number_id: campaign.twilio_number_id,
      direction: "outbound",
      status: "completed",
      outcome: "goal_met",
      goal_met: true,
      created_at: goalMetAt,
      ended_at: goalMetAt,
    });
    console.log(`Seeded ${TAG}-${s.suffix} → ${s.status} (${s.daysAgo}d ago)`);
  }
  console.log("Done.");
}

const mode = process.argv[2] ?? "seed";
const run = mode === "cleanup" ? clearExisting : seed;
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
