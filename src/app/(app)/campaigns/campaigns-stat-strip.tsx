import { DollarSign, Megaphone, PauseCircle, PhoneCall } from "lucide-react";
import Link from "next/link";

import type { CampaignStats } from "./stats-query";

/** 4-stat strip on /campaigns. Active and Paused link to their
 *  matching status tabs; Calls today and Spend today are read-only
 *  (no useful filter to land on). */
export function CampaignsStatStrip({ stats }: { stats: CampaignStats }) {
  return (
    <section
      data-testid="campaigns-stat-strip"
      className="border-border bg-card grid grid-cols-2 gap-x-4 gap-y-3 rounded-2xl border px-5 py-4 shadow-sm sm:grid-cols-4"
    >
      <StatLink
        icon={<Megaphone className="size-3.5" />}
        label="Active"
        value={stats.active.toLocaleString()}
        href="/campaigns?status=active"
        tone="coral"
        // When campaigns are live, the tile goes green with a soft
        // pulse — the AI is dialing right now.
        pulse={stats.active > 0}
      />
      <StatLink
        icon={<PauseCircle className="size-3.5" />}
        label="Paused"
        value={stats.paused.toLocaleString()}
        href="/campaigns?status=paused"
        tone="warning"
        divider
      />
      <Stat
        icon={<PhoneCall className="size-3.5" />}
        label="Calls today"
        value={stats.callsToday.toLocaleString()}
        tone="neutral"
        divider
      />
      <Stat
        icon={<DollarSign className="size-3.5" />}
        label="Spend today"
        value={`$${stats.spendToday.toFixed(2)}`}
        tone="neutral"
        divider
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
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  href: string;
  tone: "coral" | "warning" | "neutral";
  divider?: boolean;
  pulse?: boolean;
}) {
  // A live tile goes green with a soft pulse around the icon.
  const accent = pulse ? "text-success" : toneClass(tone);
  return (
    <Link
      href={href}
      className={`group focus-visible:ring-ring/60 hover:bg-muted/40 -mx-2 flex flex-col gap-1 rounded-lg px-2 py-1 transition-colors focus-visible:ring-2 focus-visible:outline-none ${
        divider ? "sm:border-border/60 sm:border-l sm:pl-4" : ""
      }`}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className={`relative inline-flex ${accent}`}>
          {pulse ? (
            <span
              className="bg-success absolute -inset-1 inline-flex animate-ping rounded-full opacity-50"
              aria-hidden
            />
          ) : null}
          <span className="relative">{icon}</span>
        </span>
        {label}
      </p>
      <p
        className={`text-2xl leading-none font-medium tabular-nums ${
          pulse ? "text-success" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </Link>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
  divider,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "coral" | "warning" | "neutral";
  divider?: boolean;
}) {
  const accent = toneClass(tone);
  return (
    <div
      className={`-mx-2 flex flex-col gap-1 rounded-lg px-2 py-1 ${
        divider ? "sm:border-border/60 sm:border-l sm:pl-4" : ""
      }`}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className={accent}>{icon}</span>
        {label}
      </p>
      <p className="text-foreground text-2xl leading-none font-medium tabular-nums">
        {value}
      </p>
    </div>
  );
}

function toneClass(tone: "coral" | "warning" | "neutral"): string {
  switch (tone) {
    case "coral":
      return "text-primary";
    case "warning":
      return "text-warning";
    case "neutral":
      return "text-muted-foreground";
  }
}
