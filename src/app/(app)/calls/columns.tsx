import { Mic, Phone, PhoneIncoming } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatPhone } from "@/lib/format-phone";
import { outcomeLabel } from "@/lib/labels";
import { exactDateTime, relativeTime } from "@/lib/relative-time";

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
  /** ElevenLabs per-call AI summary. Surfaced as a third line in the Lead
   *  cell so the call log reads as "what the AI heard," not just metadata. */
  summary: string | null;
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

/** Call statuses that mean "the dialer is on this line right now."
 *  Drives the live coral pulse in the Lead cell so the most call-
 *  centric page in the app actually feels alive. */
const ACTIVE_STATUSES = new Set([
  "queued",
  "dialing",
  "ringing",
  "in_progress",
]);

export function isActiveCall(status: string): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** Tailwind tone for a call's 0–10 score so a good call reads at a
 *  glance instead of as a bare decimal. 8+ = strong (emerald),
 *  5–7.9 = okay (amber), below 5 = weak (rose). Null scores stay
 *  muted via the caller's "—" fallback. */
export function scoreTone(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 8) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 5) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}

function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
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
      const live = isActiveCall(c.status);
      return (
        <div className="flex min-w-0 items-center gap-2.5">
          {live ? (
            <span
              className="relative flex size-4 shrink-0 items-center justify-center"
              aria-label="Live call in progress"
              title="On a call right now"
            >
              <span
                className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full opacity-70"
                style={{ backgroundColor: "var(--primary)" }}
              />
              <span
                className="relative inline-flex size-2 rounded-full"
                style={{ backgroundColor: "var(--primary)" }}
              />
            </span>
          ) : (
            <DirIcon
              className={`size-4 shrink-0 ${dirTone}`}
              aria-label={c.direction === "inbound" ? "Inbound" : "Outbound"}
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* Company name is the lead deep-link. Plain <Link>s give
                us middle-click → new tab and cmd/ctrl-click → new tab
                for free. The row's open() handler in call-row.tsx
                bails when the click target is inside an <a>, so this
                Link doesn't need onClick={stopPropagation} — which is
                important because columns.tsx is consumed by a server
                component and onClick on server JSX is a runtime
                error in Next 16. */}
            {c.leadId ? (
              <Link
                href={`/leads/${c.leadId}`}
                className="text-foreground hover:text-primary truncate text-sm font-medium underline-offset-2 hover:underline"
              >
                {c.company || "Unknown lead"}
              </Link>
            ) : (
              <span className="text-foreground truncate text-sm font-medium">
                {c.company || "Unknown lead"}
              </span>
            )}
            <span className="text-muted-foreground truncate text-[11px]">
              {c.business_phone ? (
                <span className="font-mono">
                  {formatPhone(c.business_phone)}
                </span>
              ) : null}
              {c.business_phone && c.campaignName !== "—" ? " · " : ""}
              {c.campaignName !== "—" ? c.campaignName : ""}
            </span>
            {c.summary ? (
              <span
                className="text-muted-foreground/90 inline-flex min-w-0 items-center gap-1 truncate text-[11px]"
                title={c.summary}
              >
                <Mic className="size-2.5 shrink-0" />
                <span className="truncate">{c.summary}</span>
              </span>
            ) : null}
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
      <span className="font-mono text-xs">
        {formatPhone(c.business_phone, "—")}
      </span>
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
      <span
        className="text-muted-foreground"
        title={exactDateTime(c.started_at)}
      >
        {relativeTime(c.started_at)}
      </span>
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
      <span className={`font-medium tabular-nums ${scoreTone(c.score)}`}>
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
        <span className="text-primary inline-flex items-center gap-1">
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
