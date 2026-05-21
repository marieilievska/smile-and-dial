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
  cell: (lead: DisplayLead) => React.ReactNode;
};

function humanize(value: string | null): string {
  if (!value) return "—";
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "—";
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
  },
  {
    key: "phone",
    label: "Phone",
    cell: (l) => (
      <span className="font-mono text-xs">{l.business_phone || "—"}</span>
    ),
  },
  {
    key: "email",
    label: "Email",
    cell: (l) => (
      <span className="text-muted-foreground">{l.business_email || "—"}</span>
    ),
  },
  {
    key: "status",
    label: "Status",
    sortKey: "status",
    cell: (l) => (
      <Badge variant={statusVariant(l.status)}>{humanize(l.status)}</Badge>
    ),
  },
  {
    key: "last_outcome",
    label: "Last outcome",
    cell: (l) => (
      <span className="text-muted-foreground">{humanize(l.last_outcome)}</span>
    ),
  },
  {
    key: "list",
    label: "List",
    cell: (l) => <span className="text-muted-foreground">{l.listName}</span>,
  },
  {
    key: "city",
    label: "City",
    sortKey: "city",
    cell: (l) => <span className="text-muted-foreground">{l.city || "—"}</span>,
  },
  {
    key: "state",
    label: "State",
    sortKey: "state",
    cell: (l) => (
      <span className="text-muted-foreground">{l.state || "—"}</span>
    ),
  },
  {
    key: "conversations",
    label: "Conversations",
    sortKey: "conversations",
    cell: (l) => (
      <span className="text-muted-foreground">{l.conversations}</span>
    ),
  },
  {
    key: "call_attempts",
    label: "Attempts",
    sortKey: "call_attempts",
    cell: (l) => (
      <span className="text-muted-foreground">{l.call_attempts}</span>
    ),
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
  },
  {
    key: "owner",
    label: "Owner",
    cell: (l) => <span className="text-muted-foreground">{l.ownerName}</span>,
  },
];

export const DEFAULT_COLUMN_KEYS = LEAD_COLUMNS.map((c) => c.key);
