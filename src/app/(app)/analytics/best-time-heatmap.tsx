import { createAdminClient } from "@/lib/supabase/admin";
import { loadCachedHeatmap } from "@/lib/dialer/best-time-cache";
import { computeConnectHeatmap } from "@/lib/dialer/best-time";
import type { ConnectHeatmap } from "@/lib/dialer/best-time";

/** Day labels in Mon → Sun order (Sun last, so business week reads first). */
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Mapping from our display row index (0=Mon) back to heatmap[dayOfWeek] index (0=Sun). */
const DAY_DOW = [1, 2, 3, 4, 5, 6, 0] as const;

/** Calling window: 7am–8pm keeps the grid compact and cuts empty night cells. */
const HOUR_START = 7;
const HOUR_END = 20; // exclusive, so last column is 19 (7p)

/** Format an hour (0-23) as "7a", "12p", "1p" etc. */
function fmtHour(h: number): string {
  if (h === 0) return "12a";
  if (h === 12) return "12p";
  return h < 12 ? `${h}a` : `${h - 12}p`;
}

/**
 * Map a connect rate 0-1 to a CSS opacity string for the primary colour ramp.
 * Floor is 0.07 so empty cells are slightly visible as a grid.
 */
function rateToOpacity(rate: number): number {
  // clamp to [0, 1], then map to [0.07, 1]
  const clamped = Math.max(0, Math.min(1, rate));
  return 0.07 + clamped * 0.93;
}

/** Sum total dialed calls across the grid to detect sparse data. */
function totalDialed(heatmap: ConnectHeatmap): number {
  let total = 0;
  for (const row of heatmap) {
    for (const bucket of row) {
      total += bucket.dialed;
    }
  }
  return total;
}

export async function BestTimeHeatmap() {
  const admin = createAdminClient();

  // Try cache first; fall back to a live compute if cache is absent.
  let heatmap = await loadCachedHeatmap(admin);
  if (!heatmap) {
    heatmap = await computeConnectHeatmap(admin);
  }

  const sparse = totalDialed(heatmap) < 50;

  const hours = Array.from(
    { length: HOUR_END - HOUR_START },
    (_, i) => HOUR_START + i,
  );

  return (
    <section
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-2 fill-mode-both col-span-1 rounded-xl border p-5 delay-250 duration-500 lg:col-span-2"
      aria-label="Best time to call heatmap"
    >
      <h2 className="text-foreground text-sm font-semibold">
        Best time to call
      </h2>
      <p className="text-muted-foreground mt-1 mb-4 text-xs">
        When businesses actually pick up, by local hour — based on your connect
        rates.
      </p>

      {sparse ? (
        <p className="text-muted-foreground bg-muted/40 mb-4 rounded-lg px-4 py-3 text-xs">
          Not enough call history yet — these reflect typical answer patterns
          and will sharpen as you dial.
        </p>
      ) : null}

      {/* Scrollable wrapper so the grid doesn't overflow on narrow screens */}
      <div className="overflow-x-auto">
        <table
          className="w-full border-collapse text-[11px]"
          role="grid"
          aria-label="Connect rate by day of week and hour"
        >
          <thead>
            <tr>
              {/* Empty corner above day labels */}
              <th
                scope="col"
                className="text-muted-foreground w-10 pr-2 text-right font-normal"
                aria-hidden="true"
              />
              {hours.map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="text-muted-foreground pb-1.5 text-center font-normal"
                  style={{ minWidth: "2rem" }}
                >
                  {fmtHour(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAY_LABELS.map((dayLabel, rowIdx) => {
              const dow = DAY_DOW[rowIdx];
              return (
                <tr key={dayLabel}>
                  <th
                    scope="row"
                    className="text-muted-foreground pr-2 text-right font-normal"
                  >
                    {dayLabel}
                  </th>
                  {hours.map((h) => {
                    const bucket = heatmap[dow][h];
                    const opacity = rateToOpacity(bucket.rate);
                    const ratePct = (bucket.rate * 100).toFixed(1);
                    const label = `${dayLabel} ${fmtHour(h)}: ${ratePct}% connect rate (${bucket.dialed} dialed)`;
                    return (
                      <td
                        key={h}
                        role="gridcell"
                        aria-label={label}
                        title={label}
                        className="p-0.5"
                      >
                        <div
                          className="h-6 w-full rounded-sm"
                          style={{
                            backgroundColor: `color-mix(in srgb, var(--color-primary) ${Math.round(opacity * 100)}%, transparent)`,
                          }}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center gap-2">
        <span className="text-muted-foreground text-[10px]">Lower</span>
        <div
          className="h-2 w-24 rounded-full"
          style={{
            background:
              "linear-gradient(to right, color-mix(in srgb, var(--color-primary) 7%, transparent), var(--color-primary))",
          }}
          aria-hidden="true"
        />
        <span className="text-muted-foreground text-[10px]">Higher</span>
        <span className="text-muted-foreground ml-auto text-[10px]">
          Connect rate
        </span>
      </div>
    </section>
  );
}
