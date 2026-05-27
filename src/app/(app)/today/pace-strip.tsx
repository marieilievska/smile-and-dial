import { ArrowDown, ArrowUp, Minus } from "lucide-react";

/** Horizontal band of 4 supporting metrics. Stacked label-above-value
 *  layout reads as a band of stats, not a runtogether sentence.
 *
 *  v2 — label moved above the number, numbers are larger and use
 *  font-medium (not semibold), dividers are softer and shorter. */
export function PaceStrip({ items }: { items: PaceItem[] }) {
  return (
    <section
      data-testid="pace-strip"
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-2 fill-mode-both grid grid-cols-2 gap-x-4 gap-y-5 rounded-xl border px-6 py-5 delay-200 duration-500 sm:grid-cols-4"
    >
      {items.map((item, i) => (
        <PaceEntry key={item.label} item={item} divider={i > 0} />
      ))}
    </section>
  );
}

export type PaceItem = {
  label: string;
  value: string;
  /** -1..1, where +0.12 = 12% vs prior. null = no comparison available. */
  delta?: number | null;
};

function PaceEntry({ item, divider }: { item: PaceItem; divider: boolean }) {
  return (
    <div
      className={`flex flex-col gap-1 ${
        divider ? "sm:border-border/60 sm:border-l sm:pl-4" : ""
      }`}
    >
      <p className="text-muted-foreground text-[10px] font-medium tracking-[0.16em] uppercase">
        {item.label}
      </p>
      <div className="flex items-baseline gap-2">
        <p className="text-foreground text-2xl leading-none font-medium tabular-nums">
          {item.value}
        </p>
        {item.delta !== undefined && item.delta !== null ? (
          <DeltaPill value={item.delta} />
        ) : null}
      </div>
    </div>
  );
}

function DeltaPill({ value }: { value: number }) {
  const pct = value * 100;
  const isFlat = Math.abs(pct) < 0.5;
  const up = pct > 0;
  const Icon = isFlat ? Minus : up ? ArrowUp : ArrowDown;
  const color = isFlat
    ? "text-muted-foreground"
    : up
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${color}`}
    >
      <Icon className="size-3" />
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}
