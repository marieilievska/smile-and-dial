import { ArrowDown, ArrowUp, Minus } from "lucide-react";

/** Tight horizontal band of supporting metrics. Replaces the v1 footer
 *  sentence ("Today so far: 20% connect rate…") with something that
 *  reads at a glance instead of word-by-word. */
export function PaceStrip({ items }: { items: PaceItem[] }) {
  return (
    <section
      data-testid="pace-strip"
      className="border-border bg-card flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border px-5 py-3"
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
      className={`flex items-baseline gap-2 ${
        divider ? "border-border md:border-l md:pl-6" : ""
      }`}
    >
      <p className="text-foreground text-lg font-semibold tabular-nums">
        {item.value}
      </p>
      <p className="text-muted-foreground text-xs">{item.label}</p>
      {item.delta !== undefined && item.delta !== null ? (
        <DeltaPill value={item.delta} />
      ) : null}
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
