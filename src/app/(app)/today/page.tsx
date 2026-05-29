import {
  CalendarClock,
  MailOpen,
  PauseCircle,
  PhoneMissed,
  PhoneOff,
  Sparkles,
  Target,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";

import {
  fetchActionQueue,
  fetchActiveCalls,
  fetchAppointmentPace,
  fetchAutopilotStatus,
  fetchHeroCounts,
  type ActionItem,
} from "@/lib/today/queries";
import { createClient } from "@/lib/supabase/server";

import { ActionCard } from "./action-card";
import { AutopilotStrip } from "./autopilot-strip";
import { HeroPace } from "./hero-pace";
import { LiveCallsBand } from "./live-calls-band";
import { PaceStrip, type PaceItem } from "./pace-strip";

function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(0)}%`;
}

function pctDelta(curr: number, prior: number): number | null {
  if (prior === 0) return curr === 0 ? 0 : null;
  return (curr - prior) / prior;
}

function isMockMode(): boolean {
  return (
    process.env.TWILIO_LIVE !== "live" &&
    process.env.ELEVENLABS_LIVE !== "live" &&
    process.env.OPENAI_LIVE !== "live"
  );
}

/** Map action queue kinds → icon + tone + primary CTA label. The
 *  fetchActionQueue function already gave us the right `href`. */
function actionPresentation(
  kind: ActionItem["kind"],
  urgency: ActionItem["urgency"],
): {
  icon: React.ReactNode;
  tone: "neutral" | "urgent" | "success" | "warn";
  primaryLabel: string;
} {
  switch (kind) {
    case "overdue_callback":
      return {
        icon: (
          <PhoneMissed className="size-4 text-rose-600 dark:text-rose-400" />
        ),
        tone: "urgent",
        primaryLabel: "Call back",
      };
    case "needs_status_update":
      return {
        icon: <Target className="size-4 text-amber-600 dark:text-amber-400" />,
        tone: "warn",
        primaryLabel: "Open",
      };
    case "email_reply":
      return {
        icon: (
          <MailOpen className="size-4 text-emerald-600 dark:text-emerald-400" />
        ),
        tone: "success",
        primaryLabel: "Open lead",
      };
    case "campaign_paused":
      return {
        icon: (
          <PauseCircle className="size-4 text-amber-600 dark:text-amber-400" />
        ),
        tone: urgency === "high" ? "urgent" : "warn",
        primaryLabel: "Review",
      };
    case "number_flagged":
      return {
        icon: <PhoneOff className="size-4 text-rose-600 dark:text-rose-400" />,
        tone: "urgent",
        primaryLabel: "Swap",
      };
    default:
      return {
        icon: <CalendarClock className="text-muted-foreground size-4" />,
        tone: "neutral",
        primaryLabel: "Open",
      };
  }
}

export default async function TodayPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role")
    .eq("id", user.id)
    .single();
  const isAdmin = profile?.role === "admin";

  const [counts, queue, activeCalls, pace, autopilot] = await Promise.all([
    fetchHeroCounts(supabase, { isAdmin, ownerId: user.id }),
    fetchActionQueue(supabase, { isAdmin, ownerId: user.id }),
    fetchActiveCalls(supabase, 5),
    fetchAppointmentPace(supabase),
    fetchAutopilotStatus(supabase),
  ]);

  // Greeting — time-of-day adjusted, first name only.
  const hour = new Date().getHours();
  const tod =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = (profile?.full_name ?? "").split(/\s+/)[0] || "";
  const greeting = firstName ? `${tod}, ${firstName}` : tod;
  const dateStr = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const mockMode = isMockMode();

  // Autopilot pace — rough calls/hour so far today. Guard the early-morning
  // divide-by-near-zero with a half-hour floor so the figure stays sane.
  const now = new Date();
  const hoursElapsed = Math.max(0.5, now.getHours() + now.getMinutes() / 60);
  const pacePerHour = Math.round(counts.callsToday / hoursElapsed);
  const autopilotRunning = autopilot.activeCampaigns > 0;

  // AI-aware subtitle — server-computed one-liner that reflects what's
  // actually happening right now. Priority: overdue callbacks → live
  // calls → pace vs yesterday → idle quiet.
  const paceDelta = counts.appointmentsToday - pace.yesterdayByNow;
  let subtitle: string;
  if (counts.overdueCallbacks > 0) {
    subtitle = `${counts.overdueCallbacks} overdue callback${counts.overdueCallbacks === 1 ? "" : "s"} — let's clear those first.`;
  } else if (activeCalls.total > 0) {
    subtitle = `${activeCalls.total} AI call${activeCalls.total === 1 ? "" : "s"} running right now. Nice momentum.`;
  } else if (pace.yesterdayByNow === 0 && counts.appointmentsToday === 0) {
    subtitle = "Quiet so far. The AI is dialing in the background.";
  } else if (paceDelta >= 2) {
    subtitle = `Ahead of yesterday's pace by ${paceDelta} — strong day so far.`;
  } else if (paceDelta <= -2) {
    subtitle = `Behind yesterday by ${Math.abs(paceDelta)} — let's pick it up.`;
  } else if (counts.appointmentsToday > 0) {
    subtitle = `${counts.appointmentsToday} appointment${counts.appointmentsToday === 1 ? "" : "s"} booked — keeping pace with yesterday.`;
  } else {
    subtitle = "The AI is handling things. You're free to step away.";
  }

  // Pace strip — supporting metrics with deltas.
  const paceItems: PaceItem[] = [
    {
      label: "calls",
      value: counts.callsToday.toLocaleString(),
      delta: pctDelta(counts.callsToday, counts.callsYesterday),
    },
    {
      label: "connect rate",
      value: fmtPct(counts.connectRateToday),
      delta:
        counts.connectRateYesterday > 0
          ? counts.connectRateToday - counts.connectRateYesterday
          : null,
    },
    {
      label: "pending callbacks",
      value: counts.pendingCallbacks.toLocaleString(),
      delta:
        counts.overdueCallbacks > 0
          ? // overdue is bad — surface the count as a negative delta
            -counts.overdueCallbacks / Math.max(counts.pendingCallbacks, 1)
          : undefined,
    },
    // Round 30 — dropped the "per appointment" cost tile from the
    // pace strip. Today is operational ("are we moving?"); cost-per
    // belongs on /costs and /analytics where the framing is
    // financial. Keeping three metrics tightens the band visually
    // and avoids competing with the HeroPace appointment metric
    // directly above.
  ];

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 lg:p-8">
      {/* Greeting + AI-aware subtitle + date. The greeting carries a
       *  whisper of brand tint (a soft gradient on the name) so the page
       *  opens warm without shouting, and an "AI" chip sits beside the
       *  subtitle to reinforce that this is an autonomous product. */}
      <header
        data-testid="today-greeting"
        className="animate-in fade-in slide-in-from-bottom-1 flex flex-col gap-1 duration-500"
      >
        <h1 className="text-2xl font-bold tracking-tight">
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
        <p className="text-muted-foreground/70 mt-1 text-[10px] tracking-wider uppercase">
          {dateStr}
        </p>
      </header>

      {/* Autopilot status strip — the persistent "is the AI working?" bar */}
      <AutopilotStrip
        running={autopilotRunning}
        activeCampaigns={autopilot.activeCampaigns}
        pausedCampaigns={autopilot.pausedCampaigns}
        pacePerHour={pacePerHour}
        mockMode={mockMode}
      />

      {/* Bento grid — asymmetric on large screens. The hero metric leads
       *  the wide left, the live-calls heartbeat sits in the right rail,
       *  then the pace strip and action queue run full-width below. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        {/* Hero appointment metric with inline hourly sparkline */}
        <div className="lg:col-span-2">
          <HeroPace
            current={counts.appointmentsToday}
            yesterdayByNow={pace.yesterdayByNow}
            yesterdayTotal={pace.yesterdayTotal}
            hourly={pace.hourly}
          />
        </div>

        {/* Live calls band — the AI heartbeat. Quiet one-liner when idle,
         *  expands to the call list while active. */}
        <div className="lg:col-span-1">
          <LiveCallsBand
            rows={activeCalls.rows}
            total={activeCalls.total}
            mockMode={mockMode}
          />
        </div>

        {/* Pace strip — supporting metrics, glanceable as a band */}
        <div className="lg:col-span-3">
          <PaceStrip items={paceItems} />
        </div>

        {/* Action queue — cards, not rows */}
        <section
          data-testid="action-queue"
          className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-col gap-4 delay-300 duration-500 lg:col-span-3"
        >
          <div className="flex items-baseline justify-between">
            <h2 className="text-foreground text-lg font-semibold tracking-tight">
              Up next
            </h2>
            {queue.length > 0 ? (
              <p className="text-muted-foreground text-xs">
                {queue.length} item{queue.length === 1 ? "" : "s"} waiting
              </p>
            ) : null}
          </div>

          {queue.length === 0 ? (
            <EmptyState mockMode={mockMode} idle={activeCalls.total === 0} />
          ) : (
            <div className="flex flex-col gap-3">
              {queue.map((item) => {
                const pres = actionPresentation(item.kind, item.urgency);
                return (
                  <ActionCard
                    key={item.id}
                    icon={pres.icon}
                    iconTone={pres.tone}
                    urgency={item.urgency}
                    headline={item.message}
                    primaryHref={item.href}
                    primaryLabel={pres.primaryLabel}
                  />
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function EmptyState({ mockMode, idle }: { mockMode: boolean; idle: boolean }) {
  const detail = mockMode
    ? "Mock mode running quietly. Real action items show up here when calls land."
    : idle
      ? "The dialer is idle and nothing needs your attention."
      : "The AI is handling things in the background. You're free to step away.";

  return (
    <div
      data-testid="action-queue-empty"
      className="border-border/70 bg-muted/10 flex flex-col items-center gap-4 rounded-2xl border border-dashed px-6 py-14 text-center"
    >
      <div className="text-muted-foreground/80 inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.18em] uppercase">
        <Sparkles className="size-3" />
        All clear
      </div>
      <p className="text-foreground/90 max-w-md text-base leading-relaxed">
        {detail}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href="/calls">View call activity</Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link href="/leads">Browse leads</Link>
        </Button>
      </div>
    </div>
  );
}
