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

function statusVariant(
  status: string,
): "success" | "destructive" | "secondary" {
  if (["goal_met", "sale", "closed", "attended"].includes(status)) {
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
    cell: (l) => <span className="font-medium">{l.company || "—"}</span>,
    text: (l) => l.company ?? "",
  },
  {
    key: "phone",
    label: "Phone",
    cell: (l) => (
      <span className="font-mono text-xs">{l.business_phone || "—"}</span>
    ),
    text: (l) => l.business_phone ?? "",
  },
  {
    key: "email",
    label: "Email",
    cell: (l) => (
      <span className="text-muted-foreground">{l.business_email || "—"}</span>
    ),
    text: (l) => l.business_email ?? "",
  },
  {
    key: "status",
    label: "Status",
    sortKey: "status",
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
    cell: (l) => (
      <span className="text-muted-foreground">{humanize(l.last_outcome)}</span>
    ),
    text: (l) => (l.last_outcome ? humanize(l.last_outcome) : ""),
  },
  {
    key: "list",
    label: "List",
    cell: (l) => <span className="text-muted-foreground">{l.listName}</span>,
    text: (l) => l.listName,
  },
  {
    key: "city",
    label: "City",
    sortKey: "city",
    cell: (l) => <span className="text-muted-foreground">{l.city || "—"}</span>,
    text: (l) => l.city ?? "",
  },
  {
    key: "state",
    label: "State",
    sortKey: "state",
    cell: (l) => (
      <span className="text-muted-foreground">{l.state || "—"}</span>
    ),
    text: (l) => l.state ?? "",
  },
  {
    key: "conversations",
    label: "Conversations",
    sortKey: "conversations",
    cell: (l) => (
      <span className="text-muted-foreground">{l.conversations}</span>
    ),
    text: (l) => String(l.conversations),
  },
  {
    key: "call_attempts",
    label: "Attempts",
    sortKey: "call_attempts",
    cell: (l) => (
      <span className="text-muted-foreground">{l.call_attempts}</span>
    ),
    text: (l) => String(l.call_attempts),
  },
  {
    key: "last_call",
    label: "Last call",
    sortKey: "last_call_at",
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
    cell: (l) => <span className="text-muted-foreground">{l.ownerName}</span>,
    text: (l) => l.ownerName,
  },
];

export const DEFAULT_COLUMN_KEYS = LEAD_COLUMNS.map((c) => c.key);
