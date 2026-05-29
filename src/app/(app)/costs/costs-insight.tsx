import { Lightbulb } from "lucide-react";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** A one-line, plain-English read of the spend in view. Fully
 *  deterministic — no model call — derived from KPIs the page has
 *  already computed. Turns "here are some numbers" into "here's what
 *  they mean": efficiency per call and per goal, the most efficient
 *  campaign, and the biggest vendor line. Renders nothing when there's
 *  no spend to talk about. */
export function CostsInsight({
  rangeLabel,
  calls,
  spend,
  perCall,
  perGoal,
  bestCampaign,
  topVendor,
}: {
  rangeLabel: string;
  calls: number;
  spend: number;
  perCall: number;
  perGoal: number | null;
  bestCampaign: { name: string; costPerGoal: number } | null;
  topVendor: { label: string; share: number } | null;
}) {
  if (calls === 0 || spend <= 0) return null;

  return (
    <div
      data-testid="costs-insight"
      className="border-border bg-card flex items-start gap-3 rounded-xl border px-4 py-3"
    >
      <span
        aria-hidden
        className="text-primary mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md"
        style={{
          backgroundColor:
            "color-mix(in oklab, var(--primary) 14%, transparent)",
        }}
      >
        <Lightbulb className="size-3.5" />
      </span>
      <p className="text-foreground text-sm leading-relaxed">
        Across {rangeLabel}, {calls.toLocaleString()}{" "}
        {calls === 1 ? "call" : "calls"} cost{" "}
        <span className="font-semibold">{usd(spend)}</span> — that&apos;s{" "}
        <span className="font-medium">{usd(perCall)}</span> per call
        {perGoal != null ? (
          <>
            {" "}
            and <span className="font-medium">{usd(perGoal)}</span> per goal met
          </>
        ) : null}
        .
        {bestCampaign ? (
          <>
            {" "}
            <span className="text-foreground font-medium">
              {bestCampaign.name}
            </span>{" "}
            is your most efficient at {usd(bestCampaign.costPerGoal)} per goal.
          </>
        ) : null}
        {topVendor ? (
          <>
            {" "}
            <span className="text-muted-foreground">
              {topVendor.label} is the biggest line ({topVendor.share}% of
              spend).
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}
