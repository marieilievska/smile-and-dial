import { Badge } from "@/components/ui/badge";

export type DisplayLead = {
  id: string;
  company: string | null;
  business_phone: string | null;
  business_email: string | null;
  status: string;
  last_outcome: string | null;
  city: string | null;
  state: string | null;
  conversations: number;
  call_attempts: number;
  last_call_at: string | null;
  next_call_at: string | null;
  listName: string;
  ownerName: string;
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

function humanize(value: string | null): string {
  if (!value) return "—";
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "—";
}

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
): "coral" | "success" | "destructive" | "secondary" {
  if (["ready_to_call", "callback"].includes(status)) return "coral";
  if (["sale", "goal_met", "attended", "closed"].includes(status)) {
    return "success";
  }
  if (status === "dnc") return "destructive";
  return "secondary";
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
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground truncate text-sm font-medium">
          {l.company || "—"}
        </span>
        {l.business_phone ? (
          <span className="text-muted-foreground truncate font-mono text-[11px]">
            {l.business_phone}
          </span>
        ) : null}
      </div>
    ),
    text: (l) => l.company ?? "",
  },
  {
    key: "phone",
    label: "Phone",
    width: "w-[140px]",
    cell: (l) => (
      <span className="font-mono text-xs">{l.business_phone || "—"}</span>
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
    key: "status",
    label: "Status",
    sortKey: "status",
    width: "w-[140px]",
    cell: (l) => (
      <Badge variant={statusVariant(l.status)} dot>
        {humanize(l.status)}
      </Badge>
    ),
    text: (l) => humanize(l.status),
  },
  {
    key: "last_outcome",
    label: "Last outcome",
    width: "w-[150px]",
    cell: (l) => (
      <span className="text-muted-foreground">{humanize(l.last_outcome)}</span>
    ),
    text: (l) => (l.last_outcome ? humanize(l.last_outcome) : ""),
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
    width: "w-[130px]",
    cell: (l) => (
      <span className="text-muted-foreground">{l.conversations}</span>
    ),
    text: (l) => String(l.conversations),
  },
  {
    key: "call_attempts",
    label: "Attempts",
    sortKey: "call_attempts",
    width: "w-[100px]",
    cell: (l) => (
      <span className="text-muted-foreground">{l.call_attempts}</span>
    ),
    text: (l) => String(l.call_attempts),
  },
  {
    key: "last_call",
    label: "Last call",
    sortKey: "last_call_at",
    width: "w-[110px]",
    cell: (l) => (
      <span className="text-muted-foreground">
        {formatDate(l.last_call_at)}
      </span>
    ),
    text: (l) => dateText(l.last_call_at),
  },
  {
    key: "next_call",
    label: "Next call",
    sortKey: "next_call_at",
    width: "w-[110px]",
    cell: (l) => (
      <span className="text-muted-foreground">
        {formatDate(l.next_call_at)}
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
