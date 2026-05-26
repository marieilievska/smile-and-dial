import Link from "next/link";

import { Button } from "@/components/ui/button";

/** Big, tappable card for a single action-queue item. Replaces the
 *  tight list-row pattern from v1 — each card carries an icon, a
 *  headline (verb-first), one supporting line, and an inline primary
 *  CTA so the user can act without navigating-then-finding-the-button.
 *
 *  Urgent items get an amber/rose left rail + faint glow on the card. */
export function ActionCard({
  icon,
  iconTone = "neutral",
  urgency = "normal",
  headline,
  detail,
  primaryHref,
  primaryLabel,
}: {
  icon: React.ReactNode;
  iconTone?: "neutral" | "urgent" | "success" | "warn";
  urgency?: "high" | "normal";
  headline: string;
  detail?: string;
  primaryHref: string;
  primaryLabel: string;
}) {
  const toneRing = {
    neutral: "border-border",
    urgent: "border-rose-200 dark:border-rose-900/50",
    success: "border-emerald-200 dark:border-emerald-900/50",
    warn: "border-amber-200 dark:border-amber-900/50",
  }[iconTone];

  const toneBg = {
    neutral: "bg-card",
    urgent: "bg-rose-50/40 dark:bg-rose-950/20",
    success: "bg-emerald-50/40 dark:bg-emerald-950/20",
    warn: "bg-amber-50/40 dark:bg-amber-950/20",
  }[iconTone];

  return (
    <article
      data-testid="action-queue-item"
      data-urgency={urgency}
      className={`flex items-center gap-4 rounded-xl border ${toneRing} ${toneBg} px-5 py-4 transition-all hover:shadow-sm`}
    >
      <div className="bg-background ring-border flex size-10 shrink-0 items-center justify-center rounded-full ring-1">
        {icon}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="text-foreground text-sm leading-snug font-medium">
          {headline}
        </p>
        {detail ? (
          <p className="text-muted-foreground mt-0.5 text-xs">{detail}</p>
        ) : null}
      </div>
      <Button
        asChild
        size="sm"
        variant={urgency === "high" ? "default" : "outline"}
      >
        <Link href={primaryHref}>{primaryLabel}</Link>
      </Button>
    </article>
  );
}
