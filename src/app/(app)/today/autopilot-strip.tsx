import { ArrowUpRight, Gauge, Radio } from "lucide-react";
import Link from "next/link";

/** Slim, persistent "is the AI working?" status bar that sits directly
 *  under the greeting. It answers three glance-questions: is autopilot
 *  running, how fast is it dialing, and how many campaigns are live.
 *
 *  Read-only by design — there's no single global on/off switch (the
 *  dialer runs per-campaign), so the control affordance is a quiet
 *  "Manage" link to /campaigns rather than a fake master toggle. */
export function AutopilotStrip({
  running,
  activeCampaigns,
  pausedCampaigns,
  pacePerHour,
  mockMode,
}: {
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
      data-testid="autopilot-strip"
      data-state={running ? "running" : "paused"}
      style={
        running
          ? {
              borderColor:
                "color-mix(in oklab, var(--primary) 28%, transparent)",
              backgroundImage:
                "linear-gradient(90deg, color-mix(in oklab, var(--primary) 7%, transparent), transparent 55%)",
            }
          : undefined
      }
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border px-4 py-3 duration-500"
    >
      {/* Status — pulsing dot + label */}
      <div className="flex items-center gap-2.5">
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
        <span className="text-foreground text-sm font-semibold tracking-tight">
          {running ? "Autopilot active" : "Autopilot paused"}
        </span>
      </div>

      {/* Divider */}
      <span aria-hidden className="bg-border hidden h-4 w-px sm:block" />

      {/* Pace — only meaningful while running */}
      {running ? (
        <div className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
          <Gauge className="text-primary size-3.5" />
          <span className="text-foreground font-medium tabular-nums">
            ≈{pacePerHour.toLocaleString()}
          </span>
          calls/hr
        </div>
      ) : null}

      {/* Campaign count */}
      <div className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
        <Radio className="size-3.5" />
        {campaignLabel}
      </div>

      {mockMode ? (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium tracking-wider text-amber-800 uppercase dark:bg-amber-950 dark:text-amber-200">
          Mock
        </span>
      ) : null}

      {/* Manage link — pushed to the far right */}
      <Link
        href="/campaigns"
        className="text-muted-foreground hover:text-foreground ml-auto inline-flex items-center gap-1 text-xs font-medium transition-colors"
      >
        Manage
        <ArrowUpRight className="size-3" />
      </Link>
    </section>
  );
}
