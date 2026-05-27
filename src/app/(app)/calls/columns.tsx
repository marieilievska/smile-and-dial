import { Mic, Phone, PhoneIncoming } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { outcomeLabel } from "@/lib/labels";

/** A row passed to a column's `cell` renderer. */
export type DisplayCall = {
  id: string;
  direction: "outbound" | "inbound";
  status: string;
  outcome: string | null;
  goal_met: boolean;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  talk_time_seconds: number | null;
  recording_path: string | null;
  score: number | null;
  cost_breakdown: unknown;
  hasCallback: boolean;
  leadId: string | null;
  company: string | null;
  business_phone: string | null;
  campaignName: string;
  agentName: string;
  ownerName: string;
};

export type CallColumn = {
  key: string;
  label: string;
  /** DB column name to pass to .order(). Omit for non-sortable columns. */
  sortKey?: string;
  cell: (call: DisplayCall) => React.ReactNode;
  /** Optional Tailwind width hint applied to both the header and the
   *  body cell so columns line up consistently across rows under
   *  `table-layout: fixed`. */
  width?: string;
};

/** Outcomes that visibly read as "didn't connect" — we'd never want to
 *  pretend a voicemail or busy signal is the same kind of result as a
 *  goal-met. They get a muted pill. */
const NON_CONNECT_OUTCOMES = new Set([
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "invalid_number",
  "hung_up_immediately",
]);

/** Outcomes that count as a real win for the operator. */
const WIN_OUTCOMES = new Set(["goal_met", "transferred_to_human"]);

/** Outcomes that count as hard-stop / destructive (do-not-call,
 *  AI error, etc.). */
const HARD_OUTCOMES = new Set(["dnc", "ai_error"]);

function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function fmtCost(breakdown: unknown): string {
  if (!breakdown || typeof breakdown !== "object") return "—";
  const total = (breakdown as { total?: unknown }).total;
  if (typeof total !== "number") return "—";
  return `$${total.toFixed(2)}`;
}

export function statusVariant(
  status: string,
): "coral" | "secondary" | "destructive" {
  if (["queued", "dialing", "ringing", "in_progress"].includes(status)) {
    return "coral";
  }
  if (status === "failed" || status === "cancelled") return "destructive";
  return "secondary";
}

export function outcomeVariant(
  outcome: string,
): "coral" | "success" | "destructive" | "secondary" {
  if (WIN_OUTCOMES.has(outcome)) return "success";
  if (HARD_OUTCOMES.has(outcome)) return "destructive";
  if (NON_CONNECT_OUTCOMES.has(outcome)) return "secondary";
  // "callback", "not_interested", "dm_reached" are connected-but-not-
  // closed — read coral to signal "still active work".
  return "coral";
}

export const CALL_COLUMNS: CallColumn[] = [
  {
    key: "company",
    label: "Lead",
    width: "min-w-[260px] w-[34%]",
    cell: (c) => {
      const DirIcon = c.direction === "inbound" ? PhoneIncoming : Phone;
      const dirTone =
        c.direction === "inbound"
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-muted-foreground";
      return (
        <div className="flex min-w-0 items-center gap-2.5">
          <DirIcon
            className={`size-4 shrink-0 ${dirTone}`}
            aria-label={c.direction === "inbound" ? "Inbound" : "Outbound"}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-foreground truncate text-sm font-medium">
              {c.company || "Unknown lead"}
            </span>
            <span className="text-muted-foreground truncate text-[11px]">
              {c.business_phone ? (
                <span className="font-mono">{c.business_phone}</span>
              ) : null}
              {c.business_phone && c.campaignName !== "—" ? " · " : ""}
              {c.campaignName !== "—" ? c.campaignName : ""}
            </span>
          </div>
        </div>
      );
    },
  },
  {
    key: "phone",
    label: "Phone",
    width: "w-[150px]",
    cell: (c) => (
      <span className="font-mono text-xs">{c.business_phone ?? "—"}</span>
    ),
  },
  {
    key: "campaign",
    label: "Campaign",
    width: "w-[180px]",
    cell: (c) => (
      <span className="text-muted-foreground block truncate">
        {c.campaignName}
      </span>
    ),
  },
  {
    key: "agent",
    label: "Agent",
    width: "w-[160px]",
    cell: (c) => (
      <span className="text-muted-foreground block truncate">
        {c.agentName}
      </span>
    ),
  },
  {
    key: "owner",
    label: "Owner",
    width: "w-[150px]",
    cell: (c) => (
      <span className="text-muted-foreground block truncate">
        {c.ownerName}
      </span>
    ),
  },
  {
    key: "started_at",
    label: "Started",
    sortKey: "started_at",
    width: "w-[170px]",
    cell: (c) => (
      <span className="text-muted-foreground">{fmtDateTime(c.started_at)}</span>
    ),
  },
  {
    key: "duration",
    label: "Duration",
    sortKey: "duration_seconds",
    width: "w-[110px]",
    cell: (c) => (
      <span className="text-muted-foreground tabular-nums">
        {fmtDuration(c.duration_seconds)}
      </span>
    ),
  },
  {
    key: "talk",
    label: "Talk time",
    sortKey: "talk_time_seconds",
    width: "w-[110px]",
    cell: (c) => (
      <span className="text-muted-foreground tabular-nums">
        {fmtDuration(c.talk_time_seconds)}
      </span>
    ),
  },
  // Status (queued/dialing/ringing/in_progress/completed/failed/cancelled)
  // is the technical state of one dial attempt. For finished calls in the
  // history list it's "completed" 95% of the time — pure noise. It still
  // matters for live calls, which the Today page surfaces separately, and
  // for non-completed calls inside the call detail modal where we'll
  // render it conditionally. So no Status column on this list at all.
  {
    key: "outcome",
    label: "Outcome",
    sortKey: "outcome",
    width: "w-[180px]",
    cell: (c) =>
      c.outcome ? (
        <Badge variant={outcomeVariant(c.outcome)}>
          {outcomeLabel(c.outcome)}
        </Badge>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: "score",
    label: "Score",
    width: "w-[80px]",
    cell: (c) => (
      <span className="text-muted-foreground tabular-nums">
        {c.score == null ? "—" : c.score.toFixed(1)}
      </span>
    ),
  },
  {
    key: "cost",
    label: "Cost",
    width: "w-[100px]",
    cell: (c) => (
      <span className="text-foreground font-mono text-xs tabular-nums">
        {fmtCost(c.cost_breakdown)}
      </span>
    ),
  },
  {
    key: "recording",
    label: "Recording",
    width: "w-[100px]",
    cell: (c) =>
      c.recording_path ? (
        <span className="inline-flex items-center gap-1 text-[color:var(--coral)]">
          <Mic className="size-4" aria-label="Has recording" />
          <span className="text-xs">Audio</span>
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

/** Default visible columns trimmed further per round-2 feedback:
 *  Status is redundant with Outcome (most calls are "Completed"),
 *  so it moves to opt-in via the column picker. The standalone Goal
 *  column was dropped entirely in round 5 — the Outcome pill already
 *  reads "Goal met" in emerald, so a checkmark column was duplicate
 *  signal that just took up space. */
export const DEFAULT_COLUMN_KEYS = [
  "company",
  "started_at",
  "duration",
  "outcome",
  "cost",
];

export const ALL_COLUMN_KEYS = CALL_COLUMNS.map((c) => c.key);
