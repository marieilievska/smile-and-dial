import { ArrowUpRight, Gauge, Radio, Sparkles } from "lucide-react";
import Link from "next/link";

import { LiveWaveform } from "./live-waveform";

/** The Today command bar — one elevated, ambient header that merges the
 *  greeting, the AI-aware subtitle, the date, and the autopilot status, with a
 *  live waveform that reacts to whether the AI is working right now. Replaces
 *  the old separate greeting header + autopilot strip. Theme-aware. */
export function TodayHero({
  greeting,
  subtitle,
  dateStr,
  running,
  activeCampaigns,
  pausedCampaigns,
  pacePerHour,
  liveCount,
  mockMode,
}: {
  greeting: string;
  subtitle: string;
  dateStr: string;
  running: boolean;
  activeCampaigns: number;
  pausedCampaigns: number;
  pacePerHour: number;
  liveCount: number;
  mockMode: boolean;
}) {
  const campaignLabel = running
    ? `${activeCampaigns} campaign${activeCampaigns === 1 ? "" : "s"} live`
    : pausedCampaigns > 0
      ? `${pausedCampaigns} campaign${pausedCampaigns === 1 ? "" : "s"} paused`
      : "No campaigns running";
  const live = running || liveCount > 0;

  return (
    <section
      data-testid="today-greeting"
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-1 fill-mode-both relative overflow-hidden rounded-2xl border p-6 shadow-sm duration-500 lg:p-7"
    >
      {/* Ambient wash — a soft brand bloom from the top-right corner. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(55% 130% at 100% 0%, color-mix(in oklab, var(--primary) 10%, transparent), transparent 60%)",
        }}
      />

      <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        {/* Greeting + AI subtitle */}
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground/70 text-[10px] tracking-wider uppercase">
            {dateStr}
          </p>
          <h1 className="text-2xl font-bold tracking-tight lg:text-3xl">
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(100deg, var(--foreground), color-mix(in oklab, var(--primary) 65%, var(--foreground)))",
              }}
            >
              {greeting}
            </span>
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

        {/* Live waveform + autopilot status */}
        <div className="flex flex-col items-start gap-3 md:items-end">
          <LiveWaveform active={live} className="w-40 lg:w-52" />
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
        </div>
      </div>
    </section>
  );
}
