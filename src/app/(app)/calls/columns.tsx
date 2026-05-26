import { CircleCheckBig, Mic, Phone, PhoneIncoming } from "lucide-react";

import { Badge } from "@/components/ui/badge";

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
};

const NON_CONNECT_OUTCOMES = new Set([
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "invalid_number",
]);

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

export const CALL_COLUMNS: CallColumn[] = [
  {
    key: "direction",
    label: "Direction",
    cell: (c) =>
      c.direction === "inbound" ? (
        <PhoneIncoming
          className="text-muted-foreground size-4"
          aria-label="Inbound"
        />
      ) : (
        <Phone className="text-muted-foreground size-4" aria-label="Outbound" />
      ),
  },
  {
    key: "company",
    label: "Company",
    cell: (c) => <span className="font-medium">{c.company ?? "—"}</span>,
  },
  {
    key: "phone",
    label: "Phone",
    cell: (c) => (
      <span className="font-mono text-xs">{c.business_phone ?? "—"}</span>
    ),
  },
  {
    key: "campaign",
    label: "Campaign",
    cell: (c) => (
      <span className="text-muted-foreground">{c.campaignName}</span>
    ),
  },
  {
    key: "agent",
    label: "Agent",
    cell: (c) => <span className="text-muted-foreground">{c.agentName}</span>,
  },
  {
    key: "owner",
    label: "Owner",
    cell: (c) => <span className="text-muted-foreground">{c.ownerName}</span>,
  },
  {
    key: "started_at",
    label: "Started",
    sortKey: "started_at",
    cell: (c) => (
      <span className="text-muted-foreground">{fmtDateTime(c.started_at)}</span>
    ),
  },
  {
    key: "duration",
    label: "Duration",
    sortKey: "duration_seconds",
    cell: (c) => (
      <span className="text-muted-foreground">
        {fmtDuration(c.duration_seconds)}
      </span>
    ),
  },
  {
    key: "talk",
    label: "Talk",
    sortKey: "talk_time_seconds",
    cell: (c) => (
      <span className="text-muted-foreground">
        {fmtDuration(c.talk_time_seconds)}
      </span>
    ),
  },
  {
    key: "status",
    label: "Status",
    sortKey: "status",
    cell: (c) => (
      <Badge variant="secondary" dot>
        {c.status}
      </Badge>
    ),
  },
  {
    key: "outcome",
    label: "Outcome",
    sortKey: "outcome",
    cell: (c) =>
      c.outcome ? (
        <Badge
          variant={NON_CONNECT_OUTCOMES.has(c.outcome) ? "outline" : "default"}
        >
          {c.outcome}
        </Badge>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: "goal_met",
    label: "Goal met",
    cell: (c) =>
      c.goal_met ? (
        <CircleCheckBig className="text-success size-4" aria-label="Goal met" />
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    key: "score",
    label: "Score",
    cell: (c) => (
      <span className="text-muted-foreground">
        {c.score == null ? "—" : c.score.toFixed(1)}
      </span>
    ),
  },
  {
    key: "cost",
    label: "Cost",
    cell: (c) => (
      <span className="font-mono text-xs">{fmtCost(c.cost_breakdown)}</span>
    ),
  },
  {
    key: "recording",
    label: "Rec",
    cell: (c) =>
      c.recording_path ? (
        <Mic
          className="text-muted-foreground size-4"
          aria-label="Has recording"
        />
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

/** Columns shown when the user hasn't customized via `?cols=`. */
export const DEFAULT_COLUMN_KEYS = [
  "direction",
  "company",
  "phone",
  "campaign",
  "agent",
  "started_at",
  "duration",
  "talk",
  "status",
  "outcome",
  "cost",
];
