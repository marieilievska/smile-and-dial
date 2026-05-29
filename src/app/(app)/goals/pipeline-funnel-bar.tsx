import { GOAL_STATUSES, type GoalStatus } from "@/lib/goals/goal-statuses";

import { GOAL_STATUS_LABELS } from "./status-variant";

/** A slim stacked bar showing how the pipeline is distributed across
 *  the five goal stages. Turns the same numbers the tabs carry into a
 *  glanceable funnel — so even on the table view you can read "most of
 *  the pipeline is still awaiting attended" at a glance.
 *
 *  Pure presentational server component. Counts are the
 *  filter-independent totals (same source as the tab badges) so the
 *  funnel always tells the whole-pipeline story. */

/** Per-stage fill colors. Kept aligned with the badge semantics in
 *  status-variant.ts: goal_met = coral/primary, attended = emerald,
 *  no_show = amber, sale = deep emerald (the win), closed = muted. */
const STAGE_COLOR: Record<GoalStatus, string> = {
  goal_met: "var(--primary)",
  attended: "#34d399", // emerald-400
  no_show: "#f59e0b", // amber-500
  sale: "#059669", // emerald-600 — the win, a deeper green than attended
  closed: "var(--muted-foreground)",
};

export function PipelineFunnelBar({
  counts,
}: {
  counts: Record<string, number>;
}) {
  const stages = GOAL_STATUSES.map((status) => ({
    status,
    label: GOAL_STATUS_LABELS[status],
    count: counts[status] ?? 0,
    color: STAGE_COLOR[status],
  }));
  const total = stages.reduce((sum, s) => sum + s.count, 0);
  if (total === 0) return null;

  return (
    <section
      data-testid="pipeline-funnel"
      aria-label="Pipeline distribution by stage"
      className="flex flex-col gap-2"
    >
      <div className="bg-muted flex h-2.5 w-full overflow-hidden rounded-full">
        {stages.map((s) =>
          s.count > 0 ? (
            <div
              key={s.status}
              className="h-full transition-[width] duration-500"
              style={{
                width: `${(s.count / total) * 100}%`,
                backgroundColor: s.color,
              }}
              title={`${s.label}: ${s.count}`}
            />
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {stages.map((s) => (
          <span
            key={s.status}
            className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]"
          >
            <span
              className="inline-block size-2 rounded-full"
              style={{ backgroundColor: s.color }}
              aria-hidden
            />
            {s.label}
            <span className="text-foreground font-medium tabular-nums">
              {s.count}
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}
