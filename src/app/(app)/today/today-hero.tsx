import { ArrowUpRight, Gauge, Radio, Sparkles } from "lucide-react";
import Link from "next/link";

/** The Today command bar — a compact header: greeting, AI-aware subtitle,
 *  date, and the autopilot status in one calm row. Round 41 — trimmed the
 *  ambient wash, gradient greeting text, and the waveform so the operational
 *  content below (Up next, live calls, metrics) leads the page instead of the
 *  chrome. Theme-aware. */
export function TodayHero({
  greeting,
  subtitle,
  dateStr,
  running,
  activeCampaigns,
  pausedCampaigns,
  pacePerHour,
  mockMode,
}: {
  greeting: string;
  subtitle: string;
  dateStr: string;
  running: boolean;
  activeCampaigns: number;
  pausedCampaigns: number;
  pacePerHour: number;
  mockMode: boolean;
}) {
  const campaignLabel = running
    ? `${activeCampaigns} campaign${activeCampaigns === 1 ? "" : "s"} live`
    : pausedCampaigns > 0
      ? `${pausedCampaigns} campaign${pausedCampaigns === 1 ? "" : "s"} paused`
      : "No campaigns running";

  return (
    <section
      data-testid="today-greeting"
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex flex-col gap-4 rounded-2xl border p-5 shadow-sm duration-500 md:flex-row md:items-center md:justify-between"
    >
      {/* Greeting + AI subtitle */}
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground/70 text-[10px] tracking-wider uppercase">
          {dateStr}
        </p>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          {greeting}
        </h1>
        <div className="flex items-center gap-2">
          <span
            className="text-primary inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase"
            style={{
              backgroundColor:
                "color-mix(in oklab, var(--primary) 12%, transparent)",
            }}
          >
            <Sparkles className="size-3" />
            AI
          </span>
          <p
            data-testid="today-subtitle"
            className="text-muted-foreground text-sm"
          >
            {subtitle}
          </p>
        </div>
      </div>

      {/* Autopilot status */}
      <div
        data-testid="autopilot-strip"
        data-state={running ? "running" : "paused"}
        className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm md:justify-end"
      >
        <span className="inline-flex items-center gap-2">
          {running ? (
            <span aria-hidden className="relative flex size-2.5 shrink-0">
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                style={{ backgroundColor: "var(--primary)" }}
              />
              <span
                className="relative inline-flex size-2.5 rounded-full"
                style={{ backgroundColor: "var(--primary)" }}
              />
            </span>
          ) : (
            <span
              aria-hidden
              className="bg-muted-foreground/40 size-2.5 shrink-0 rounded-full"
            />
          )}
          <span className="text-foreground font-semibold tracking-tight">
            {running ? "Autopilot active" : "Autopilot paused"}
          </span>
        </span>

        {running ? (
          <span className="text-muted-foreground inline-flex items-center gap-1.5">
            <Gauge className="text-primary size-3.5" />
            <span className="text-foreground font-medium tabular-nums">
              ≈{pacePerHour.toLocaleString()}
            </span>
            calls/hr
          </span>
        ) : null}

        <span className="text-muted-foreground inline-flex items-center gap-1.5">
          <Radio className="size-3.5" />
          {campaignLabel}
        </span>

        {mockMode ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium tracking-wider text-amber-800 uppercase dark:bg-amber-950 dark:text-amber-200">
            Mock
          </span>
        ) : null}

        <Link
          href="/campaigns"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs font-medium transition-colors"
        >
          Manage
          <ArrowUpRight className="size-3" />
        </Link>
      </div>
    </section>
  );
}
