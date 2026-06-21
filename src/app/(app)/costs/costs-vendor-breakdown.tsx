import { Phone } from "lucide-react";

import type { rollupByVendor } from "@/lib/analytics/costs";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

/** Per-vendor cost breakdown — a single segmented spend bar plus a legend with
 *  $ and %. Each vendor has a fixed colour (paired with its name + % in the
 *  legend, so colour is never the only cue). Phone-number rental is a flat
 *  monthly fee billed separately, shown on its own line below a divider and NOT
 *  folded into the per-call vendor total. */
export function CostsVendorBreakdown({
  summary,
  extraLookupCost = 0,
  monthlyNumberCost = 0,
  numberCount = 0,
}: {
  summary: ReturnType<typeof rollupByVendor>;
  extraLookupCost?: number;
  monthlyNumberCost?: number;
  numberCount?: number;
}) {
  const vendorTotal = summary.total + extraLookupCost;
  const items = [
    {
      label: "ElevenLabs",
      note: "voice + LLM",
      key: "elevenlabs" as const,
      value: summary.elevenlabs,
      color: "#D85A30",
    },
    {
      label: "Twilio calls",
      note: "connection & talk time",
      key: "twilio" as const,
      value: summary.twilio,
      color: "#378ADD",
    },
    {
      label: "Twilio lookup",
      note: "number checks",
      key: "lookup" as const,
      value: summary.lookup + extraLookupCost,
      color: "#1D9E75",
    },
    {
      label: "OpenAI",
      note: "summaries & transcription",
      key: "openai" as const,
      value: summary.openai,
      color: "#7F77DD",
    },
  ].sort((a, b) => b.value - a.value);

  return (
    <section
      className="border-border bg-card flex flex-col gap-4 rounded-2xl border p-5 shadow-sm"
      data-testid="per-vendor-chart"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">
          Where the money goes
        </h2>
        <p className="text-muted-foreground text-xs tabular-nums">
          {usd(vendorTotal)} across vendors
        </p>
      </div>

      <div className="bg-muted flex h-3.5 w-full overflow-hidden rounded-full">
        {items.map((i) => {
          const pct = vendorTotal > 0 ? (i.value / vendorTotal) * 100 : 0;
          if (pct <= 0) return null;
          return (
            <div
              key={i.key}
              style={{ width: `${pct}%`, background: i.color }}
              title={`${i.label} ${pct.toFixed(0)}%`}
            />
          );
        })}
      </div>

      <ul className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {items.map((i) => {
          const share =
            vendorTotal > 0
              ? `${((i.value / vendorTotal) * 100).toFixed(0)}%`
              : "—";
          return (
            <li
              key={i.key}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="text-muted-foreground inline-flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block size-2.5 shrink-0 rounded-[3px]"
                  style={{ background: i.color }}
                />
                <span className="text-foreground font-medium">{i.label}</span>
                <span className="text-muted-foreground hidden text-xs sm:inline">
                  {i.note}
                </span>
              </span>
              <span className="text-foreground tabular-nums">
                {usd(i.value)}{" "}
                <span className="text-muted-foreground">· {share}</span>
              </span>
            </li>
          );
        })}
      </ul>

      <div className="border-border/70 flex items-baseline justify-between gap-3 border-t pt-3">
        <span className="text-foreground inline-flex items-center gap-2">
          <Phone className="text-muted-foreground size-3.5 shrink-0" />
          <span className="font-medium">Phone numbers</span>
          <span className="text-muted-foreground hidden text-xs sm:inline">
            {numberCount > 0
              ? `${numberCount} active · flat monthly fee`
              : "no active numbers"}
          </span>
        </span>
        <span className="text-foreground tabular-nums">
          {usd(monthlyNumberCost)}
          <span className="text-muted-foreground">/mo</span>
        </span>
      </div>
      <p className="text-muted-foreground text-[11px]">
        The vendor rows are per-call costs for the selected range. Phone numbers
        are a flat monthly rental, shown on their own line.
      </p>
    </section>
  );
}
