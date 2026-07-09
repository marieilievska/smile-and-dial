import { Mic, Phone, PhoneIncoming } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatPhone } from "@/lib/format-phone";
import { outcomeLabel } from "@/lib/labels";
import {
  callStatusBadgeVariant,
  outcomeBadgeVariant,
  scoreTone,
} from "@/lib/outcome-style";
import { exactDateTime, relativeTime } from "@/lib/relative-time";

// Re-exported under their historical names for the few callers that
// still import them from this file. Colors now live in
// `@/lib/outcome-style` (the single source of truth).
export { scoreTone };
export const statusVariant = callStatusBadgeVariant;
export const outcomeVariant = outcomeBadgeVariant;

/** A row passed to a column's `cell` renderer. */
export type DisplayCall = {
  id: string;
  direction: "outbound" | "inbound";
  call_mode: "ai" | "human";
  status: string;
  outcome: string | null;
  goal_met: boolean;
  /** The LEAD's "decision maker reached" flag (the single source of truth — set
   *  by the transcript analysis or the manual toggle). Shown per call so the
   *  Calls page agrees with the Leads page. */
  decisionMakerReached: boolean;
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
  /** Which of the lead's numbers this call dialed. "owner" surfaces an
   *  "Owner line" chip so owner calls are distinguishable from business ones. */
  dialedTarget: "business" | "owner" | null;
  /** Review evidence for the active `review_flag` view (empty otherwise). Each
   *  entry is the AI's quote + status for a flag on this call. Surfaced in the
   *  `review_evidence` column so the operator sees WHY a call is in the bucket. */
  reviewEvidence: {
    flagKey: string;
    evidenceQuote: string | null;
    status: "confirmed" | "needs_review" | "rejected";
  }[];
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
            <div className="mt-0.5 flex flex-wrap items-center gap-1">
              {c.dialedTarget === "owner" ? (
                <span className="inline-flex w-fit items-center gap-1 rounded-full bg-sky-500/12 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-sky-700 uppercase dark:text-sky-400">
                  Owner line
                </span>
              ) : null}
              {c.call_mode === "human" ? (
                <span className="inline-flex w-fit items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-700 uppercase dark:text-emerald-400">
                  Human
                </span>
              ) : null}
            </div>
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
  // Talk-time column removed: ElevenLabs never reports a separate talk-time
  // figure (only total duration, shown above), so the column was always empty.
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
    key: "dm_reached",
    label: "DM reached",
    width: "w-[120px]",
    /** Did this call get past any gatekeeper to the decision maker? Emerald
     *  "Yes" reads as a win; a quiet dash otherwise. */
    cell: (c) =>
      c.decisionMakerReached ? (
        <span className="text-foreground/80 inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-emerald-500"
          />
          Yes
        </span>
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
  {
    key: "review_evidence",
    label: "Why flagged",
    width: "w-[280px]",
    cell: (call: DisplayCall) => {
      if (call.reviewEvidence.length === 0)
        return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-col gap-1">
          {call.reviewEvidence.map((e, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              {e.status === "needs_review" ? (
                <Badge
                  variant="outline"
                  className="w-fit border-amber-300 text-amber-700"
                >
                  needs eyes
                </Badge>
              ) : null}
              <span className="text-muted-foreground line-clamp-2 text-xs italic">
                {e.evidenceQuote ? `“${e.evidenceQuote}”` : "No quote captured"}
              </span>
            </div>
          ))}
        </div>
      );
    },
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
  "dm_reached",
  "cost",
];

export const ALL_COLUMN_KEYS = CALL_COLUMNS.map((c) => c.key);
