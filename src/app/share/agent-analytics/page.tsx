import { createClient as createServiceClient } from "@supabase/supabase-js";

import { DashboardView } from "@/app/(app)/agent-analytics/dashboard-view";
import {
  computeDailyKpis,
  sinceDaysAgoIso,
  yesterdayEt,
  type AgentCallRow,
} from "@/lib/agent-analytics/stats";
import type { Database } from "@/lib/supabase/database.types";

// Public, read-only share of the Market Research KPI dashboard — no login.
// Aggregate counts only (no customer names/phones/reasons). Never indexed.
export const metadata = {
  title: "Market Research — Call Results",
  robots: { index: false, follow: false },
};

const HISTORY_DAYS = 30;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="bg-background text-foreground min-h-screen">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Market Research — Call Results
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Read-only shared view · updates live · aggregate numbers only.
          </p>
        </div>
        {children}
      </div>
    </main>
  );
}

export default async function PublicMarketResearchDashboard() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    return (
      <Shell>
        <p className="text-muted-foreground text-sm">
          This dashboard is temporarily unavailable.
        </p>
      </Shell>
    );
  }
  // Service-role client: this page has no logged-in user. The key stays
  // server-side; only aggregate KPI counts are rendered to the page.
  const supabase = createServiceClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .ilike("name", "%market research%")
    .maybeSingle();
  if (!agent) {
    return (
      <Shell>
        <p className="text-muted-foreground text-sm">No data yet.</p>
      </Shell>
    );
  }

  const since = sinceDaysAgoIso(HISTORY_DAYS);
  const { data } = await supabase
    .from("calls")
    .select("started_at, outcome, duration_seconds, extracted_data")
    .eq("agent_id", agent.id)
    .eq("direction", "outbound")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(5000);

  const kpis = computeDailyKpis((data ?? []) as AgentCallRow[]);
  return (
    <Shell>
      <DashboardView
        kpis={kpis}
        day={yesterdayEt()}
        historyDays={HISTORY_DAYS}
      />
    </Shell>
  );
}
