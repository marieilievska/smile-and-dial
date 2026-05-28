import Link from "next/link";

import { Badge } from "@/components/ui/badge";

const TABS: {
  value: string;
  label: string;
  tone: "neutral" | "red" | "coral";
}[] = [
  { value: "any", label: "All", tone: "neutral" },
  { value: "error", label: "Errors", tone: "red" },
  { value: "warn", label: "Warnings", tone: "coral" },
  { value: "info", label: "Info", tone: "neutral" },
];

/** Severity segmented control. Round 22 — replaces the severity
 *  dropdown with a pill row showing the match count per severity
 *  inside the current filter window. Matches the costs view-tabs
 *  treatment: real <a> links so screen readers see a navigation
 *  rather than a synthetic tablist. */
export function SeverityTabs({
  current,
  counts,
  buildHref,
}: {
  current: string;
  counts: { info: number; warn: number; error: number; total: number };
  buildHref: (severity: string) => string;
}) {
  const valueFor = (key: string): number => {
    if (key === "any") return counts.total;
    if (key === "error") return counts.error;
    if (key === "warn") return counts.warn;
    return counts.info;
  };
  const dot = (tone: "neutral" | "red" | "coral"): string => {
    switch (tone) {
      case "red":
        return "bg-destructive";
      case "coral":
        return "bg-[color:var(--coral)]";
      default:
        return "bg-muted-foreground/50";
    }
  };
  return (
    <nav
      aria-label="Filter by severity"
      data-testid="severity-tabs"
      className="border-border bg-background inline-flex flex-wrap items-center gap-0.5 self-start rounded-lg border p-1"
    >
      {TABS.map((t) => {
        const active = current === t.value;
        return (
          <Link
            key={t.value}
            href={buildHref(t.value)}
            aria-current={active ? "page" : undefined}
            className={`inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}
          >
            {t.value !== "any" ? (
              <span
                aria-hidden
                className={`size-1.5 rounded-full ${dot(t.tone)}`}
              />
            ) : null}
            {t.label}
            <Badge
              variant={active ? "secondary" : "outline"}
              className="px-1.5 py-0 text-[10px] tabular-nums"
            >
              {valueFor(t.value).toLocaleString()}
            </Badge>
          </Link>
        );
      })}
    </nav>
  );
}
