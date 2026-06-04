import { Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatPhone } from "@/lib/format-phone";
import { leadStatusLabel, outcomeLabel } from "@/lib/labels";
import { exactDateTime, relativeTimeSigned } from "@/lib/relative-time";

export type DisplayLead = {
  id: string;
  company: string | null;
  business_phone: string | null;
  business_email: string | null;
  status: string;
  last_outcome: string | null;
  category: string | null;
  city: string | null;
  state: string | null;
  conversations: number;
  call_attempts: number;
  last_call_at: string | null;
  next_call_at: string | null;
  /** Round 36+ (I3) — added alongside `listName` so the inline list
   *  cell can identify which option is currently selected without
   *  matching by name (names can repeat across legacy data). */
  listId: string | null;
  listName: string;
  ownerName: string;
  /** True when the dialer has a call in flight for this lead right now —
   *  drives the live "On call" pulse in the primary cell. */
  onCall?: boolean;
  /** Rolling AI summary of everything the agent has learned across this
   *  lead's calls (maintained by the summary-merger). Surfaced as a third
   *  line in the primary cell so the table reads as an AI product. */
  aiSummary?: string | null;
  /** True when the lead was created in the last 24h — drives a "New" chip. */
  isNew?: boolean;
};

export type LeadColumn = {
  key: string;
  label: string;
  /** DB column to sort by. Omit for non-sortable columns. */
  sortKey?: string;
  /** Rendered cell for the Leads table. */
  cell: (lead: DisplayLead) => React.ReactNode;
  /** Plain-text value for the CSV export. */
  text: (lead: DisplayLead) => string;
  /** Optional Tailwind width hint applied to both the header and the
   *  body cell so columns line up consistently across rows. */
  width?: string;
};

/** Date for CSV: blank rather than an em dash when there is no value. */
function dateText(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "";
}

/** Status palette tightened to navy + coral + emerald + one neutral.
 *  Three buckets: Active (coral) for in-flight work, Won (emerald) for
 *  good outcomes, Closed-out (muted) for everything else.
 *
 *  Returns the *Badge variant token name*; the matching styles live in
 *  the Badge component. We also extend the Badge here with a coral
 *  variant via the dedicated `coral` value (see badge.tsx). */
export function statusVariant(
  status: string,
): "coral" | "success" | "warning" | "destructive" | "secondary" {
  // Active work — AI is still moving the lead forward.
  if (["ready_to_call", "callback", "goal_met"].includes(status)) {
    return "coral";
  }
  // Positive milestones — they showed up, they bought.
  if (["attended", "sale"].includes(status)) return "success";
  // Needs rebooking attention but not lost.
  if (status === "no_show") return "warning";
  // Lost / hard-stop.
  if (["dnc", "closed"].includes(status)) return "destructive";
  // Email replied, resting, etc.
  return "secondary";
}

/** Tailwind class for a tiny tone dot beside the Last outcome label.
 *  Same three-bucket logic as the Calls page outcome palette: wins are
 *  emerald, hard stops rose, still-active work primary, everything else
 *  a quiet muted dot. Keeps the column from being a wall of flat gray. */
const WIN_OUTCOMES = new Set(["goal_met", "sale", "attended"]);
const HARD_OUTCOMES = new Set([
  "dnc",
  "invalid_number",
  "failed",
  "not_interested",
]);
const ACTIVE_OUTCOMES = new Set([
  "callback",
  "dm_reached",
  "transferred_to_human",
  "gatekeeper",
  "ai_receptionist",
]);

function outcomeDotClass(outcome: string): string {
  if (WIN_OUTCOMES.has(outcome)) return "bg-emerald-500";
  if (HARD_OUTCOMES.has(outcome)) return "bg-rose-500";
  if (ACTIVE_OUTCOMES.has(outcome)) return "bg-primary";
  return "bg-muted-foreground/40";
}

/** Faint stage-colored left rail revealed on row hover. Returns a
 *  group-hover border-color class keyed to the same status buckets as
 *  `statusVariant`. The transparent base border is always present so
 *  the 2px never causes a layout shift — only the color changes. */
export function statusRailClass(status: string): string {
  switch (statusVariant(status)) {
    case "coral":
      return "group-hover:border-l-[color:var(--primary)]";
    case "success":
      return "group-hover:border-l-emerald-500";
    case "warning":
      return "group-hover:border-l-amber-500";
    case "destructive":
      return "group-hover:border-l-rose-400";
    default:
      return "group-hover:border-l-border";
  }
}

export const LEAD_COLUMNS: LeadColumn[] = [
  {
    key: "company",
    label: "Company",
    sortKey: "company",
    width: "min-w-[220px] w-[28%]",
    /** Primary identity cell: company name (strong) on top, phone
     *  (mono, muted) underneath. One column carries the identity so
     *  rows scan as "lead cards" rather than wide flat strips. */
    cell: (l) => (
      <div className="flex min-w-0 items-center gap-2">
        {l.onCall ? (
          <span
            aria-hidden
            title="On a call right now"
            className="relative flex size-2 shrink-0"
          >
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
              style={{ backgroundColor: "var(--primary)" }}
            />
            <span
              className="relative inline-flex size-2 rounded-full"
              style={{ backgroundColor: "var(--primary)" }}
            />
          </span>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="text-foreground truncate text-sm font-medium">
              {l.company || "—"}
            </span>
            {l.isNew ? (
              <span className="border-primary/30 text-primary inline-flex shrink-0 items-center rounded-full border px-1.5 text-[9px] font-semibold tracking-wide uppercase">
                New
              </span>
            ) : null}
          </span>
          {l.onCall ? (
            <span className="text-primary truncate text-[11px] font-medium">
              On call now
            </span>
          ) : l.business_phone ? (
            <span className="text-muted-foreground truncate font-mono text-[11px]">
              {formatPhone(l.business_phone)}
            </span>
          ) : null}
          {!l.onCall && l.aiSummary ? (
            <span
              className="text-muted-foreground/90 inline-flex min-w-0 items-center gap-1 truncate text-[11px]"
              title={l.aiSummary}
            >
              <Sparkles className="size-2.5 shrink-0" />
              <span className="truncate">{l.aiSummary}</span>
            </span>
          ) : null}
        </div>
      </div>
    ),
    text: (l) => l.company ?? "",
  },
  {
    key: "phone",
    label: "Phone",
    width: "w-[140px]",
    cell: (l) => (
      <span className="font-mono text-xs">
        {formatPhone(l.business_phone, "—")}
      </span>
    ),
    text: (l) => l.business_phone ?? "",
  },
  {
    key: "email",
    label: "Email",
    width: "w-[200px]",
    cell: (l) => (
      <span className="text-muted-foreground truncate">
        {l.business_email || "—"}
      </span>
    ),
    text: (l) => l.business_email ?? "",
  },
  {
    // Column key stays "status" so saved views / sort URLs keep working,
    // but the user-facing label is "Stage" — the word "Status" collided
    // with call status (queued/ringing/completed) and confused people.
    key: "status",
    label: "Stage",
    sortKey: "status",
    width: "w-[140px]",
    cell: (l) => (
      <Badge variant={statusVariant(l.status)} dot>
        {leadStatusLabel(l.status)}
      </Badge>
    ),
    text: (l) => leadStatusLabel(l.status),
  },
  {
    key: "last_outcome",
    label: "Last outcome",
    width: "w-[150px]",
    cell: (l) =>
      l.last_outcome ? (
        <span className="text-foreground/80 inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${outcomeDotClass(
              l.last_outcome,
            )}`}
          />
          {outcomeLabel(l.last_outcome)}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    text: (l) => (l.last_outcome ? outcomeLabel(l.last_outcome) : ""),
  },
  {
    key: "list",
    label: "List",
    width: "w-[180px]",
    cell: (l) => (
      <span className="text-muted-foreground block truncate">{l.listName}</span>
    ),
    text: (l) => l.listName,
  },
  {
    key: "category",
    label: "Category",
    sortKey: "category",
    width: "w-[160px]",
    cell: (l) => (
      <span
        className="text-muted-foreground block truncate"
        title={l.category ?? undefined}
      >
        {l.category || "—"}
      </span>
    ),
    text: (l) => l.category ?? "",
  },
  {
    key: "city",
    label: "City",
    sortKey: "city",
    width: "w-[120px]",
    cell: (l) => <span className="text-muted-foreground">{l.city || "—"}</span>,
    text: (l) => l.city ?? "",
  },
  {
    key: "state",
    label: "State",
    sortKey: "state",
    width: "w-[80px]",
    cell: (l) => (
      <span className="text-muted-foreground">{l.state || "—"}</span>
    ),
    text: (l) => l.state ?? "",
  },
  {
    key: "conversations",
    label: "Conversations",
    sortKey: "conversations",
    width: "w-[130px] text-right",
    cell: (l) => (
      <span className="text-foreground/80 block text-right tabular-nums">
        {l.conversations}
      </span>
    ),
    text: (l) => String(l.conversations),
  },
  {
    key: "call_attempts",
    label: "Attempts",
    sortKey: "call_attempts",
    width: "w-[100px] text-right",
    cell: (l) => (
      <span className="text-foreground/80 block text-right tabular-nums">
        {l.call_attempts}
      </span>
    ),
    text: (l) => String(l.call_attempts),
  },
  {
    key: "last_call",
    label: "Last call",
    sortKey: "last_call_at",
    width: "w-[110px]",
    /** Relative time scans far faster than a raw date; the exact
     *  timestamp stays one hover away in the title. */
    cell: (l) => (
      <span
        className="text-muted-foreground"
        title={exactDateTime(l.last_call_at)}
      >
        {relativeTimeSigned(l.last_call_at)}
      </span>
    ),
    text: (l) => dateText(l.last_call_at),
  },
  {
    key: "next_call",
    label: "Next call",
    sortKey: "next_call_at",
    width: "w-[110px]",
    /** Future-facing relative time ("in 2h"). The precise value the
     *  dialer schedules against is preserved in the hover title and the
     *  CSV export. */
    cell: (l) => (
      <span
        className="text-muted-foreground"
        title={exactDateTime(l.next_call_at)}
      >
        {relativeTimeSigned(l.next_call_at)}
      </span>
    ),
    text: (l) => dateText(l.next_call_at),
  },
  {
    key: "owner",
    label: "Owner",
    width: "w-[140px]",
    cell: (l) => (
      <span className="text-muted-foreground block truncate">
        {l.ownerName}
      </span>
    ),
    text: (l) => l.ownerName,
  },
];

/** What shows by default: 6 columns instead of all 13. Phone and email
 *  are folded into the primary `company` cell so they're not redundant.
 *  The Column picker lets users add the rest. */
export const DEFAULT_COLUMN_KEYS = [
  "company",
  "category",
  "status",
  "last_outcome",
  "list",
  "last_call",
  "next_call",
  "owner",
];

/** Every column key, used by the column picker so users can opt in to
 *  the columns that aren't shown by default. */
export const ALL_COLUMN_KEYS = LEAD_COLUMNS.map((c) => c.key);
