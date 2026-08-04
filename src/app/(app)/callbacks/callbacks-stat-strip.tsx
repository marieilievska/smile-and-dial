import { AlarmClock, CalendarDays, Mic, TriangleAlert } from "lucide-react";
import Link from "next/link";

import type { CallbackStats } from "./stats-query";

/** 4-stat strip under the /callbacks header. Mirrors LeadsStatStrip and
 *  CallsStatStrip — tile-per-stat layout, each tile a clickable filter
 *  shortcut that pre-applies the relevant URL params.
 *
 *  The Overdue tile uses destructive red because it's an alarm (the
 *  cron should have caught these; if it didn't, the SDR needs to act).
 *  Repeat-voicemail uses coral as an "attention" cue — these still
 *  need human follow-up even though they're not technically broken. */
export function CallbacksStatStrip({ stats }: { stats: CallbackStats }) {
  return (
    <section
      data-testid="callbacks-stat-strip"
      className="border-border bg-card grid grid-cols-2 gap-x-4 gap-y-3 rounded-2xl border px-5 py-4 shadow-sm sm:grid-cols-4"
    >
      <StatLink
        icon={<AlarmClock className="size-3.5" />}
        label="Due today"
        value={stats.dueToday.toLocaleString()}
        href="/callbacks?status=pending&range=today"
        tone="coral"
        hint="Callbacks scheduled to dial today."
      />
      <StatLink
        icon={<CalendarDays className="size-3.5" />}
        label="Due this week"
        value={stats.dueThisWeek.toLocaleString()}
        href="/callbacks?status=pending&range=week"
        tone="neutral"
        divider
        hint="Callbacks scheduled over the next 7 days."
      />
      <StatLink
        icon={<TriangleAlert className="size-3.5" />}
        label="Overdue"
        value={stats.overdue.toLocaleString()}
        href="/callbacks?status=pending&range=overdue"
        tone="red"
        divider
        // Overdue pending callbacks aren't broken — they're queued. The
        // autopilot dials them on its next pass, so a gentle pulse pulls
        // the eye without implying something has failed.
        pulse={stats.overdue > 0}
        hint="Past their scheduled time. The autopilot dials these on its next pass — or use Call now on a row to handle one yourself."
      />
      <StatLink
        icon={<Mic className="size-3.5" />}
        label="Voicemail ≥2"
        value={stats.repeatVoicemail.toLocaleString()}
        href="/callbacks?status=pending&voicemail=repeat"
        tone="coral"
        divider
        hint="The AI has already left 2+ voicemails on these — a human may need to step in."
      />
    </section>
  );
}

function StatLink({
  icon,
  label,
  value,
  href,
  tone,
  divider,
  pulse,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href: string;
  tone: "coral" | "red" | "neutral";
  divider?: boolean;
  pulse?: boolean;
  hint?: string;
}) {
  const accent = {
    coral: "text-primary",
    red: "text-destructive",
    neutral: "text-muted-foreground",
  }[tone];

  return (
    <Link
      href={href}
      title={hint}
      className={`group focus-visible:ring-ring/60 hover:bg-muted/40 -mx-2 flex flex-col gap-1 rounded-lg px-2 py-1 transition-colors focus-visible:ring-2 focus-visible:outline-none ${
        divider ? "sm:border-border/60 sm:border-l sm:pl-4" : ""
      }`}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        {pulse ? (
          <span className="relative inline-flex size-3.5 items-center justify-center">
            <span
              className="absolute inline-flex size-3.5 animate-ping rounded-full opacity-60"
              style={{ backgroundColor: "var(--destructive)" }}
            />
            <span className={`relative ${accent}`}>{icon}</span>
          </span>
        ) : (
          <span className={accent}>{icon}</span>
        )}
        {label}
      </p>
      <p
        className={`text-2xl leading-none font-medium tabular-nums ${
          pulse ? "text-destructive" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </Link>
  );
}
