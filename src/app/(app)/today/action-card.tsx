import { ChevronRight } from "lucide-react";
import Link from "next/link";

/** Big, fully-clickable card for a single action-queue item. The entire
 *  card is a link — no nested anchor / button. We keep a visual CTA on
 *  the right (a chevron + label) so people see *what* clicking does, but
 *  the whole surface is the hit target.
 *
 *  Urgent items get a rose left rail + tinted background. */
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
    neutral: "bg-card hover:bg-muted/40",
    urgent:
      "bg-rose-50/40 hover:bg-rose-50/70 dark:bg-rose-950/20 dark:hover:bg-rose-950/30",
    success:
      "bg-emerald-50/40 hover:bg-emerald-50/70 dark:bg-emerald-950/20 dark:hover:bg-emerald-950/30",
    warn: "bg-amber-50/40 hover:bg-amber-50/70 dark:bg-amber-950/20 dark:hover:bg-amber-950/30",
  }[iconTone];

  const toneRail = {
    neutral: "",
    urgent:
      "before:absolute before:inset-y-0 before:left-0 before:w-1 before:rounded-l-xl before:bg-rose-400 dark:before:bg-rose-500",
    success: "",
    warn: "before:absolute before:inset-y-0 before:left-0 before:w-1 before:rounded-l-xl before:bg-amber-400 dark:before:bg-amber-500",
  }[iconTone];

  return (
    <Link
      href={primaryHref}
      data-testid="action-queue-item"
      data-urgency={urgency}
      aria-label={`${headline} — ${primaryLabel}`}
      className={`group relative flex items-center gap-4 rounded-xl border ${toneRing} ${toneBg} ${toneRail} focus-visible:ring-ring/60 px-5 py-4 transition-all hover:-translate-y-px hover:shadow-md focus-visible:ring-2 focus-visible:outline-none`}
    >
      <div className="bg-background ring-border flex size-10 shrink-0 items-center justify-center rounded-full ring-1 transition-transform group-hover:scale-105">
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
      <div className="text-muted-foreground group-hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors">
        <span className="hidden sm:inline">{primaryLabel}</span>
        <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
