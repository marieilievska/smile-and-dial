import { PhoneCall, Target, Trophy } from "lucide-react";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** Three efficiency KPIs under the hero: cost per goal met, cost per call, and
 *  goals met (with conversion rate). Values are computed on the page. */
export function CostsKpiStrip({
  perGoal,
  perCall,
  goalMet,
  totalCalls,
}: {
  perGoal: number | null;
  perCall: number;
  goalMet: number;
  totalCalls: number;
}) {
  const rate = totalCalls === 0 ? 0 : Math.round((goalMet / totalCalls) * 100);
  return (
    <section
      data-testid="costs-kpi-strip"
      className="grid grid-cols-1 gap-4 sm:grid-cols-3"
    >
      <Kpi
        icon={<Target className="size-3.5" />}
        label="Cost per goal met"
        value={perGoal == null ? "—" : usd(perGoal)}
        sub={`${goalMet.toLocaleString()} goals met`}
      />
      <Kpi
        icon={<PhoneCall className="size-3.5" />}
        label="Cost per call"
        value={usd(perCall)}
        sub={`${totalCalls.toLocaleString()} calls`}
      />
      <Kpi
        icon={<Trophy className="size-3.5" />}
        label="Goals met"
        value={goalMet.toLocaleString()}
        sub={`${rate}% of calls`}
      />
    </section>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="border-border bg-card flex flex-col gap-1 rounded-2xl border p-5 shadow-sm">
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className="text-primary">{icon}</span>
        {label}
      </p>
      <p className="text-foreground text-2xl leading-none font-medium tabular-nums">
        {value}
      </p>
      <p className="text-muted-foreground text-[11px] tabular-nums">{sub}</p>
    </div>
  );
}
