import {
  CAUSE_GROUP,
  CAUSE_LABEL,
  CAUSE_ORDER,
  type CauseKey,
  type CauseResult,
} from "@/lib/agent-analytics/cause-of-death";

const GROUP_TITLE = {
  final: "Final losses",
  in_play: "Still in play",
  won: "Won",
} as const;

const BAR_COLOR: Record<CauseKey, string> = {
  won: "bg-emerald-500",
  callback_booked: "bg-sky-500",
  mid_follow_up: "bg-sky-400",
  dm_said_no: "bg-rose-500",
  gatekeeper: "bg-amber-500",
  never_reached: "bg-zinc-400",
  bad_number: "bg-zinc-500",
  brush_off: "bg-amber-400",
  opted_out: "bg-rose-600",
  other: "bg-zinc-400",
};

export function CauseOfDeathView({
  result,
  companyByLead,
}: {
  result: CauseResult;
  companyByLead: Record<string, string>;
}) {
  const { total, counts, groups, perLead } = result;
  if (total === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No leads were worked in this window for the selected scope.
      </p>
    );
  }
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
  const companiesFor = (cause: CauseKey) =>
    perLead
      .filter((l) => l.cause === cause)
      .map((l) => companyByLead[l.leadId] || "(unknown)");

  const renderGroup = (group: "final" | "in_play" | "won") => {
    const causes = CAUSE_ORDER.filter(
      (c) => CAUSE_GROUP[c] === group && counts[c] > 0,
    );
    if (causes.length === 0) return null;
    return (
      <section key={group} className="space-y-2">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          {GROUP_TITLE[group]} ({groups[group]})
        </h3>
        <div className="space-y-2">
          {causes.map((cause) => {
            const n = counts[cause];
            const companies = companiesFor(cause);
            return (
              <details key={cause} className="group">
                <summary className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1">
                  <span className="w-48 shrink-0 text-sm font-medium">
                    {CAUSE_LABEL[cause]}
                    {cause === "dm_said_no" ? (
                      <span className="text-muted-foreground ml-1 text-xs">
                        (objection breakdown coming soon)
                      </span>
                    ) : null}
                  </span>
                  <span className="bg-muted relative h-3 flex-1 overflow-hidden rounded-full">
                    <span
                      className={`absolute inset-y-0 left-0 rounded-full ${BAR_COLOR[cause]}`}
                      style={{ width: `${Math.max(2, pct(n))}%` }}
                    />
                  </span>
                  <span className="w-24 shrink-0 text-right text-sm tabular-nums">
                    {n} · {pct(n)}%
                  </span>
                </summary>
                <ul className="text-muted-foreground mt-1 max-h-56 overflow-auto pl-4 text-xs">
                  {companies.map((c, i) => (
                    <li key={i} className="py-0.5">
                      {c}
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Worked leads" value={total} />
        <Tile label="Won (goal met)" value={groups.won} />
        <Tile label="Final losses" value={groups.final} />
        <Tile label="Still in play" value={groups.in_play} />
      </div>
      {renderGroup("final")}
      {renderGroup("in_play")}
      {renderGroup("won")}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-border bg-card rounded-xl border p-4 shadow-sm">
      <div className="text-muted-foreground text-xs font-medium">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
