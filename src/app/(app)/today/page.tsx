import {
  CalendarClock,
  CheckCircle2,
  MailOpen,
  PauseCircle,
  PhoneMissed,
  PhoneOff,
  Target,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { HeroKpi } from "@/app/(app)/analytics/hero-kpi";
import { Badge } from "@/components/ui/badge";
import {
  fetch7dCallTrend,
  fetchActionQueue,
  fetchHeroCounts,
  type ActionItem,
} from "@/lib/today/queries";
import { createClient } from "@/lib/supabase/server";

function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(0)}%`;
}

function fmtUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "—";
  return `$${value.toFixed(2)}`;
}

function fmtRelativeOverdue(minutes: number | null): string | null {
  if (minutes == null) return null;
  if (minutes < 60) return `${minutes}m overdue`;
  const h = Math.floor(minutes / 60);
  return `${h}h overdue`;
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

const KIND_ICON: Record<ActionItem["kind"], React.ElementType> = {
  overdue_callback: PhoneMissed,
  needs_status_update: Target,
  email_reply: MailOpen,
  campaign_paused: PauseCircle,
  number_flagged: PhoneOff,
};

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

  const [counts, queue, trend] = await Promise.all([
    fetchHeroCounts(supabase, { isAdmin, ownerId: user.id }),
    fetchActionQueue(supabase, { isAdmin, ownerId: user.id }),
    fetch7dCallTrend(supabase),
  ]);

  // Greeting: first-name only, no exclamation mark, time-of-day appropriate.
  const hour = new Date().getHours();
  const tod =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = (profile?.full_name ?? "").split(/\s+/)[0] || "";
  const greeting = firstName ? `${tod}, ${firstName}` : tod;

  const overdueLabel = fmtRelativeOverdue(counts.oldestOverdueMinutes);
  const mockMode = isMockMode();

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          {greeting}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {new Date().toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </p>
      </div>

      {/* Hero KPI row — three tiles, side by side. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <HeroKpi
          label="Calls today"
          value={counts.callsToday.toLocaleString()}
          deltaPct={pctDelta(counts.callsToday, counts.callsYesterday)}
          priorValue={counts.callsYesterday}
        />
        <HeroKpi
          label="Appointments today"
          value={counts.appointmentsToday.toLocaleString()}
          deltaPct={pctDelta(
            counts.appointmentsToday,
            counts.appointmentsYesterday,
          )}
          priorValue={counts.appointmentsYesterday}
          badge={mockMode ? { label: "Mock data", tone: "warn" } : null}
        />
        <HeroKpi
          label="Pending callbacks"
          value={counts.pendingCallbacks.toLocaleString()}
          helper={
            counts.overdueCallbacks > 0
              ? `${counts.overdueCallbacks} overdue${overdueLabel ? ` · oldest ${overdueLabel}` : ""}`
              : counts.pendingCallbacks === 0
                ? "Nothing scheduled"
                : "All on schedule"
          }
        />
      </div>

      {/* Two-column body — action queue (left, wider) + at-a-glance (right). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Action queue */}
        <section
          data-testid="action-queue"
          className="border-border bg-card rounded-lg border p-4 lg:col-span-2"
        >
          <h2 className="text-foreground text-sm font-semibold">
            What needs you
          </h2>
          <p className="text-muted-foreground mt-1 mb-4 text-xs">
            Items that need attention from someone today.
          </p>
          {queue.length === 0 ? (
            <div className="flex items-center gap-3 py-6">
              <CheckCircle2 className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <div>
                <p className="text-foreground text-sm font-medium">
                  You&apos;re caught up.
                </p>
                <p className="text-muted-foreground text-sm">
                  New work shows up here as it arrives.
                </p>
              </div>
            </div>
          ) : (
            <ul className="flex flex-col gap-1">
              {queue.map((item) => {
                const Icon = KIND_ICON[item.kind] ?? CalendarClock;
                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      data-testid="action-queue-item"
                      data-urgency={item.urgency}
                      className="hover:bg-muted/60 flex items-center gap-3 rounded-md px-2 py-2 transition-colors"
                    >
                      <Icon
                        className={
                          item.urgency === "high"
                            ? "size-4 shrink-0 text-rose-600 dark:text-rose-400"
                            : "text-muted-foreground size-4 shrink-0"
                        }
                      />
                      <span className="text-foreground flex-1 text-sm">
                        {item.message}
                      </span>
                      {item.urgency === "high" ? (
                        <Badge variant="destructive">Urgent</Badge>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* At-a-glance: 7-day call trend */}
        <section className="border-border bg-card rounded-lg border p-4">
          <h2 className="text-foreground text-sm font-semibold">
            Calls this week
          </h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            Daily call volume across the last 7 days.
          </p>
          <Sparkline7d trend={trend} />
        </section>
      </div>

      {/* Footer connect-rate hint — keeps the inventory feel without
          competing with the hero. */}
      <p className="text-muted-foreground text-sm">
        <span className="text-foreground font-medium">Today so far:</span>{" "}
        {fmtPct(counts.connectRateToday)} connect rate
        {counts.connectRateYesterday > 0 ? (
          <> (was {fmtPct(counts.connectRateYesterday)} yesterday)</>
        ) : null}
        {counts.appointmentsToday > 0 ? (
          <>
            {" "}
            · {fmtUsd(counts.costPerAppointmentToday)} per appointment
            {mockMode ? (
              <span className="text-muted-foreground/80"> (mock)</span>
            ) : null}
          </>
        ) : null}
      </p>
    </div>
  );
}

/** Sparkline-style 7-day trend rendered inline. */
function Sparkline7d({ trend }: { trend: { day: string; count: number }[] }) {
  const width = 280;
  const height = 120;
  const padding = 12;
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const max = Math.max(1, ...trend.map((t) => t.count));
  const barW = trend.length === 0 ? 0 : innerW / trend.length;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="text-primary h-32 w-full"
      role="img"
      aria-label="Calls per day over the last 7 days"
    >
      {trend.map((t, i) => {
        const h = (t.count / max) * innerH;
        const x = padding + i * barW;
        const y = padding + (innerH - h);
        return (
          <rect
            key={t.day}
            x={x + 2}
            y={y}
            width={Math.max(1, barW - 4)}
            height={h}
            fill="currentColor"
            opacity={t.count === 0 ? 0.15 : 0.85}
            rx={2}
          />
        );
      })}
      <line
        x1={padding}
        y1={height - padding}
        x2={width - padding}
        y2={height - padding}
        stroke="currentColor"
        strokeOpacity={0.18}
      />
    </svg>
  );
}
