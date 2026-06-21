import Link from "next/link";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

export type TopCampaign = {
  campaignId: string;
  name: string;
  spend: number;
  goalMet: number;
  costPerGoalMet: number;
};

/** Compact "top campaigns by spend" list — name, spend bar, spend, and
 *  cost/goal. Sits beside the vendor breakdown. Sourced from rollupByCampaign
 *  on the page. */
export function CostsTopCampaigns({ items }: { items: TopCampaign[] }) {
  if (items.length === 0) {
    return (
      <section className="border-border bg-card rounded-2xl border p-5 shadow-sm">
        <h2 className="text-foreground text-sm font-semibold">
          Top campaigns by spend
        </h2>
        <p className="text-muted-foreground mt-3 text-sm">
          No campaign spend in this range.
        </p>
      </section>
    );
  }
  const max = Math.max(0.01, ...items.map((i) => i.spend));
  return (
    <section
      data-testid="costs-top-campaigns"
      className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-5 shadow-sm"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">
          Top campaigns by spend
        </h2>
        <p className="text-muted-foreground text-xs">spend · cost / goal</p>
      </div>
      <ul className="flex flex-col gap-3">
        {items.map((i) => {
          const pct = (i.spend / max) * 100;
          return (
            <li key={i.campaignId} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <Link
                  href={`/calls?campaign=${i.campaignId}`}
                  className="text-foreground font-medium underline-offset-4 hover:underline"
                >
                  {i.name}
                </Link>
                <span className="text-muted-foreground tabular-nums">
                  {usd(i.spend)} ·{" "}
                  {i.goalMet === 0 ? "—" : usd(i.costPerGoalMet)}
                </span>
              </div>
              <div className="bg-muted h-1.5 w-full overflow-hidden rounded">
                <div
                  className="h-full"
                  style={{
                    width: `${Math.max(2, pct)}%`,
                    background: "var(--primary)",
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
