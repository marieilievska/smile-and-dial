import {
  CAUSE_ACTION,
  CAUSE_DESCRIPTION,
  CAUSE_GROUP,
  CAUSE_LABEL,
  CAUSE_ORDER,
  NO_CONTACT_LABEL,
  type CauseKey,
  type CauseResult,
  type NoContactReason,
} from "@/lib/agent-analytics/cause-of-death";
import {
  computeObjectionBreakdown,
  type ObjectionBreakdown,
  type ObjectionRow,
} from "@/lib/agent-analytics/objections";
import type { ObjectionCategory } from "@/lib/openai/objection-extractor";

const GROUP_TITLE = {
  final: "Final losses",
  in_play: "Still in play",
  won: "Won",
} as const;

const OBJECTION_LABEL: Record<ObjectionCategory, string> = {
  price: "Price / budget",
  already_have_solution: "Already have a solution",
  no_need: "No need",
  bad_timing: "Bad timing",
  happy_with_current: "Happy with current",
  confused_by_offer: "Confused by offer",
  distrust_spam: "Distrust / spam",
  brush_off: "Brush-off",
  other: "Other",
};

const BAR_COLOR: Record<CauseKey, string> = {
  won: "bg-emerald-500",
  callback_booked: "bg-sky-500",
  mid_follow_up: "bg-sky-400",
  dm_said_no: "bg-rose-500",
  gatekeeper: "bg-amber-500",
  bad_number: "bg-zinc-500",
  no_contact: "bg-zinc-400",
  opted_out: "bg-rose-600",
};

/** Causes whose why-detail is an objection breakdown (a person was reached). */
const OBJECTION_CAUSES = new Set<CauseKey>(["dm_said_no", "gatekeeper"]);

export function CauseOfDeathView({
  result,
  companyByLead,
  objectionsByCause = {},
}: {
  result: CauseResult;
  companyByLead: Record<string, string>;
  objectionsByCause?: Partial<Record<CauseKey, ObjectionRow[]>>;
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

  // "No real contact" → group its leads by the furthest sub-reason we reached.
  const noContactGroups = () => {
    const m = new Map<NoContactReason, string[]>();
    for (const l of perLead) {
      if (l.cause !== "no_contact" || !l.noContact) continue;
      const arr = m.get(l.noContact) ?? [];
      arr.push(companyByLead[l.leadId] || "(unknown)");
      m.set(l.noContact, arr);
    }
    return (Object.keys(NO_CONTACT_LABEL) as NoContactReason[])
      .filter((r) => m.has(r))
      .map((r) => ({ reason: r, companies: m.get(r)! }));
  };

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
            return (
              <details key={cause} className="group">
                <summary className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1">
                  <span className="w-48 shrink-0 text-sm font-medium">
                    {CAUSE_LABEL[cause]}
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
                <div className="mt-1 space-y-2 pl-4">
                  {/* Plain-English: what it means + what to do. */}
                  <p className="text-muted-foreground text-xs">
                    {CAUSE_DESCRIPTION[cause]}
                  </p>
                  {CAUSE_ACTION[cause] ? (
                    <p className="text-xs">
                      <span className="font-semibold">Next: </span>
                      <span className="text-muted-foreground">
                        {CAUSE_ACTION[cause]}
                      </span>
                    </p>
                  ) : null}

                  {/* Why-detail. */}
                  {OBJECTION_CAUSES.has(cause) ? (
                    <ObjectionBreakdown
                      breakdown={computeObjectionBreakdown(
                        objectionsByCause[cause] ?? [],
                      )}
                    />
                  ) : cause === "no_contact" ? (
                    <div className="space-y-2">
                      {noContactGroups().map(({ reason, companies }) => (
                        <details key={reason}>
                          <summary className="cursor-pointer text-xs font-medium">
                            {NO_CONTACT_LABEL[reason]} ({companies.length})
                          </summary>
                          <ul className="text-muted-foreground mt-1 max-h-40 overflow-auto pl-3 text-xs">
                            {companies.map((c, i) => (
                              <li key={i} className="py-0.5">
                                {c}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ))}
                    </div>
                  ) : (
                    <ul className="text-muted-foreground max-h-56 overflow-auto text-xs">
                      {companiesFor(cause).map((c, i) => (
                        <li key={i} className="py-0.5">
                          {c}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
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

/** Objection intelligence for a reached-a-person cause: a bar per category with
 *  verbatim quote samples beneath it. */
function ObjectionBreakdown({ breakdown }: { breakdown: ObjectionBreakdown }) {
  if (breakdown.total === 0) {
    return (
      <p className="text-muted-foreground text-xs italic">
        No objection detail yet (analysis may still be running).
      </p>
    );
  }
  const objPct = (n: number) =>
    breakdown.total ? Math.round((n / breakdown.total) * 100) : 0;
  return (
    <div className="space-y-2">
      {breakdown.byCategory.map((b) => (
        <div key={b.category} className="space-y-1">
          <div className="flex items-center gap-3">
            <span className="w-44 shrink-0 text-xs font-medium">
              {OBJECTION_LABEL[b.category]}
            </span>
            <span className="bg-muted relative h-2 flex-1 overflow-hidden rounded-full">
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-rose-400"
                style={{ width: `${Math.max(2, objPct(b.count))}%` }}
              />
            </span>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums">
              {b.count} · {objPct(b.count)}%
            </span>
          </div>
          <ul className="text-muted-foreground max-h-40 overflow-auto pl-2 text-xs">
            {b.samples.map((s, i) => (
              <li key={i} className="py-0.5">
                {[
                  s.company || "(unknown)",
                  s.specific,
                  s.quote ? `“${s.quote}”` : "",
                ]
                  .filter(Boolean)
                  .join(" — ")}
              </li>
            ))}
          </ul>
        </div>
      ))}
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
