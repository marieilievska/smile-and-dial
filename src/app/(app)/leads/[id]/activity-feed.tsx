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
import Link from "next/link";

import { humanizeFallback, outcomeLabel } from "@/lib/labels";
import { relativeTime } from "@/lib/relative-time";

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

export function LeadActivityFeed({
  items,
  leadId,
}: {
  items: FeedItem[];
  /** Lead this feed belongs to. Used to build the call-detail-modal
   *  deep link (`/leads/<id>?call=<callId>`) for `kind: "call"` items
   *  so the audio + transcript open inline. */
  leadId: string;
}) {
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
      className="relative flex flex-col gap-3 text-sm"
    >
      {/* Connecting rail behind the icon bubbles so the stream reads as a
          chronological timeline rather than a flat list. The bubbles
          (z-10) sit on top; the line aligns to their 14px center. */}
      {items.length > 1 ? (
        <span
          aria-hidden
          className="bg-border absolute top-3 bottom-3 left-[13.5px] w-px"
        />
      ) : null}
      {items.map((item) => {
        const body = (
          <>
            <FeedIcon item={item} />
            <div className="flex flex-1 flex-col gap-0.5">
              <FeedLine item={item} />
              <p className="text-muted-foreground text-xs">
                {relativeTime(item.at)} · {new Date(item.at).toLocaleString()}
              </p>
            </div>
          </>
        );

        // Call items become clickable: opens the CallDetailModal that's
        // also mounted on the lead detail page. Email and event items
        // stay non-interactive — they have no detail surface yet.
        if (item.kind === "call") {
          return (
            <li key={`call-${item.id}`}>
              <Link
                href={`/leads/${leadId}?call=${item.id}`}
                scroll={false}
                className="hover:bg-muted/40 -mx-2 flex gap-3 rounded-md px-2 py-1 transition-colors"
              >
                {body}
              </Link>
            </li>
          );
        }
        return (
          <li key={`${item.kind}-${item.id}`} className="flex gap-3">
            {body}
          </li>
        );
      })}
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
      className={`bg-muted ring-card relative z-10 mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full ring-2 ${tone}`}
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
