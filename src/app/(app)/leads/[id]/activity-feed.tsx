import {
  CalendarClock,
  Mail,
  MailOpen,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  Voicemail,
  type LucideIcon,
} from "lucide-react";

import { humanizeFallback, outcomeLabel } from "@/lib/labels";

/** Activity feed for the lead detail route. Merges three sources into
 *  one chronological stream:
 *    - calls (outbound + inbound) with outcome + duration
 *    - emails (sent + received) with subject
 *    - system_events scoped to this lead (status overrides, callback
 *      changes, Calendly events, Close webhook landings, etc.)
 *
 *  Close's activity feed is the pattern we're borrowing — but pre-
 *  filtered: we don't want the AI's per-call retry noise drowning out
 *  meaningful human-relevant events. */

export type FeedItem =
  | {
      kind: "call";
      id: string;
      at: string;
      direction: "inbound" | "outbound";
      outcome: string | null;
      duration: number | null;
      summary: string | null;
    }
  | {
      kind: "email";
      id: string;
      at: string;
      direction: "sent" | "received";
      subject: string | null;
    }
  | {
      kind: "event";
      id: string;
      at: string;
      eventKind: string;
      payload: Record<string, unknown> | null;
    };

function fmtSeconds(s: number | null): string {
  if (!s || s <= 0) return "—";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec.toString().padStart(2, "0")}s`;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(1, Math.floor((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function callIcon(outcome: string | null, direction: string): LucideIcon {
  if (direction === "inbound") return PhoneIncoming;
  if (outcome === "voicemail") return Voicemail;
  if (outcome === "no_answer" || outcome === "busy") return PhoneMissed;
  return Phone;
}

function describeCall(item: Extract<FeedItem, { kind: "call" }>): string {
  const directionLabel = item.direction === "inbound" ? "Inbound call" : "Call";
  if (item.outcome) {
    return `${directionLabel} · ${outcomeLabel(item.outcome)}`;
  }
  return directionLabel;
}

function describeEvent(item: Extract<FeedItem, { kind: "event" }>): string {
  // Friendly translations for the kinds the user is likely to see.
  switch (item.eventKind) {
    case "call_now":
      return "Manual Call Now placed";
    case "outcome_override":
      return "Outcome overridden manually";
    case "callback_changed":
      return "Callback rescheduled or cancelled";
    case "goal_transition":
      return "Goal pipeline status changed";
    case "merge_completed":
      return "Inbound lead merged into this record";
    case "calendly_scheduled":
      return "Calendly appointment booked";
    case "calendly_canceled":
      return "Calendly appointment canceled";
    case "close_email_received":
      return "Email reply received (Close)";
    case "spend_cap_hit":
      return "Campaign hit a spend cap";
    default:
      return humanizeFallback(item.eventKind);
  }
}

export function LeadActivityFeed({ items }: { items: FeedItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No activity yet. Calls, emails, and status changes will appear here as
        they happen.
      </p>
    );
  }
  return (
    <ol
      data-testid="lead-activity-feed"
      className="flex flex-col gap-3 text-sm"
    >
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`} className="flex gap-3">
          <FeedIcon item={item} />
          <div className="flex flex-1 flex-col gap-0.5">
            <FeedLine item={item} />
            <p className="text-muted-foreground text-xs">
              {relativeTime(item.at)} · {new Date(item.at).toLocaleString()}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function feedIconAndTone(item: FeedItem): { Icon: LucideIcon; tone: string } {
  if (item.kind === "call") {
    let tone = "text-muted-foreground";
    if (item.outcome === "goal_met")
      tone = "text-emerald-600 dark:text-emerald-400";
    else if (item.outcome === "dnc") tone = "text-rose-600 dark:text-rose-400";
    return { Icon: callIcon(item.outcome, item.direction), tone };
  }
  if (item.kind === "email") {
    return {
      Icon: item.direction === "received" ? MailOpen : Mail,
      tone:
        item.direction === "received"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-muted-foreground",
    };
  }
  return { Icon: CalendarClock, tone: "text-muted-foreground" };
}

function FeedIcon({ item }: { item: FeedItem }) {
  const { Icon, tone } = feedIconAndTone(item);
  return (
    <span
      className={`bg-muted/40 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ${tone}`}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

function FeedLine({ item }: { item: FeedItem }) {
  if (item.kind === "call") {
    return (
      <div className="flex flex-col">
        <p className="text-foreground font-medium">{describeCall(item)}</p>
        {item.duration != null && item.duration > 0 ? (
          <p className="text-muted-foreground text-xs">
            {fmtSeconds(item.duration)}
            {item.summary ? ` · ${item.summary}` : ""}
          </p>
        ) : item.summary ? (
          <p className="text-muted-foreground text-xs">{item.summary}</p>
        ) : null}
      </div>
    );
  }
  if (item.kind === "email") {
    const verb =
      item.direction === "received" ? "Email received" : "Email sent";
    return (
      <div className="flex flex-col">
        <p className="text-foreground font-medium">{verb}</p>
        {item.subject ? (
          <p className="text-muted-foreground text-xs">{item.subject}</p>
        ) : null}
      </div>
    );
  }
  return <p className="text-foreground font-medium">{describeEvent(item)}</p>;
}
