import type { rollupByVendor } from "@/lib/analytics/costs";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** Per-vendor cost breakdown — always visible on /costs so the owner
 *  can see exactly where the money goes by provider without hunting
 *  for a tab. Each row pairs the vendor name with a plain-English note
 *  of what it pays for. Monochrome against `--primary` (it's four
 *  shares of one bill, not four competing brands); bar length and an
 *  opacity ramp carry magnitude, ordered by share descending.
 *
 *  Note: per-call costs only. Monthly phone-number rental is a flat
 *  fee billed separately, so it isn't represented here. */
export function CostsVendorBreakdown({
  summary,
}: {
  summary: ReturnType<typeof rollupByVendor>;
}) {
  const items = [
    {
      label: "Twilio Calls",
      note: "Phone connection & talk time",
      key: "twilio" as const,
      value: summary.twilio,
    },
    {
      label: "ElevenLabs",
      note: "AI voice generation",
      key: "elevenlabs" as const,
      value: summary.elevenlabs,
    },
    {
      label: "OpenAI",
      note: "Conversation language model",
      key: "openai" as const,
      value: summary.openai,
    },
    {
      label: "Twilio Lookup",
      note: "Number validation checks",
      key: "lookup" as const,
      value: summary.lookup,
    },
  ].sort((a, b) => b.value - a.value);
  const max = Math.max(0.01, ...items.map((i) => i.value));
  // Biggest share is solid; smallest is a quiet wash. Four steps for
  // four vendors.
  const opacities = [1, 0.7, 0.45, 0.25];

  return (
    <section
      className="border-border bg-card flex flex-col gap-3 rounded-xl border p-5"
      data-testid="per-vendor-chart"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">
          Where the money goes
        </h2>
        <p className="text-muted-foreground text-xs tabular-nums">
          Total across vendors: {usd(summary.total)}
        </p>
      </div>
      <ul className="flex flex-col gap-3 text-sm">
        {items.map((i, idx) => {
          const pct = (i.value / max) * 100;
          const share =
            summary.total > 0
              ? `${((i.value / summary.total) * 100).toFixed(0)}%`
              : "—";
          const opacity = opacities[idx] ?? 0.25;
          return (
            <li key={i.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-foreground inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ background: "var(--primary)", opacity }}
                  />
                  <span className="font-medium">{i.label}</span>
                  <span className="text-muted-foreground hidden text-xs sm:inline">
                    · {i.note}
                  </span>
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {usd(i.value)} ({share})
                </span>
              </div>
              <div className="bg-muted h-3 w-full overflow-hidden rounded">
                <div
                  className="h-full"
                  style={{
                    width: `${Math.max(i.value > 0 ? 2 : 0, pct)}%`,
                    background: "var(--primary)",
                    opacity,
                  }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground text-[11px]">
        Per-call costs only. Monthly phone-number rental is billed separately.
      </p>
    </section>
  );
}
