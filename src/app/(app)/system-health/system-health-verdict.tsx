import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import Link from "next/link";

/** The one-glance answer at the top of /system-health. A health page
 *  should lead with a verdict — "is anything wrong right now?" — not a
 *  table of numbers the admin has to interpret. Three states:
 *
 *   - healthy (green): no errors or warnings in the last 24h.
 *   - caution (amber): warnings but no errors.
 *   - attention (red): one or more errors.
 *
 *  The error/caution variants deep-link to the matching severity tab so
 *  the verdict doubles as the first triage step. */
export function SystemHealthVerdict({
  errors,
  warns,
}: {
  errors: number;
  warns: number;
}) {
  const tone: "ok" | "warn" | "error" =
    errors > 0 ? "error" : warns > 0 ? "warn" : "ok";

  const plural = (n: number, word: string) =>
    `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

  const config = {
    ok: {
      icon: <CheckCircle2 className="size-5" />,
      title: "All systems healthy",
      detail: "No errors or warnings in the last 24 hours.",
      cta: null as { href: string; label: string } | null,
      classes: "border-success/30 bg-success/5 text-success",
    },
    warn: {
      icon: <AlertTriangle className="size-5" />,
      title: `${plural(warns, "warning")} in the last 24h`,
      detail: "No errors — worth a look when you get a chance.",
      cta: { href: "/system-health?severity=warn", label: "Review warnings" },
      classes: "border-warning/30 bg-warning/5 text-warning",
    },
    error: {
      icon: <AlertCircle className="size-5" />,
      title: `${plural(errors, "error")} need attention`,
      detail:
        warns > 0
          ? `Plus ${plural(warns, "warning")} in the last 24h. Start with the errors.`
          : "In the last 24 hours. Start with the errors below.",
      cta: { href: "/system-health?severity=error", label: "Review errors" },
      classes: "border-destructive/30 bg-destructive/5 text-destructive",
    },
  }[tone];

  return (
    <section
      data-testid="system-health-verdict"
      data-tone={tone}
      className={`flex items-center justify-between gap-4 rounded-xl border px-5 py-4 ${config.classes}`}
    >
      <div className="flex items-center gap-3">
        <span className="shrink-0">{config.icon}</span>
        <div className="flex flex-col gap-0.5">
          <p className="text-base leading-none font-semibold">{config.title}</p>
          <p className="text-foreground/70 text-sm">{config.detail}</p>
        </div>
      </div>
      {config.cta ? (
        <Link
          href={config.cta.href}
          className="shrink-0 rounded-md border border-current px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-opacity hover:opacity-75"
        >
          {config.cta.label}
        </Link>
      ) : null}
    </section>
  );
}
