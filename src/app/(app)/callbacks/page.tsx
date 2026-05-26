import { CalendarClock } from "lucide-react";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

import { CallbackRowActions } from "./callback-row-actions";

const STATUS_VALUES = new Set(["pending", "completed", "missed", "cancelled"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function fmtDateTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  completed: "Completed",
  missed: "Missed",
  cancelled: "Cancelled",
};

export default async function CallbacksPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    campaign?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const params = await searchParams;
  const statusFilter = STATUS_VALUES.has(str(params.status))
    ? str(params.status)
    : "pending"; // pending by default — it's the action queue
  const campaignFilter = UUID_RE.test(str(params.campaign))
    ? str(params.campaign)
    : "";
  const fromFilter = DATE_RE.test(str(params.from)) ? str(params.from) : "";
  const toFilter = DATE_RE.test(str(params.to)) ? str(params.to) : "";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Campaign list for the filter dropdown — RLS scopes for members.
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, name")
    .order("name");

  let query = supabase
    .from("callbacks")
    .select(
      "id, scheduled_at, status, voicemail_attempts, created_by, created_at, " +
        "lead:leads(id, company, business_phone), " +
        "campaign:campaigns(id, name), " +
        "originating_call_id, result_call_id",
    )
    .order("scheduled_at", { ascending: true });
  if (statusFilter) query = query.eq("status", statusFilter);
  if (campaignFilter) query = query.eq("campaign_id", campaignFilter);
  if (fromFilter) query = query.gte("scheduled_at", fromFilter);
  if (toFilter) query = query.lte("scheduled_at", `${toFilter}T23:59:59`);

  // The Supabase type generator can't keep narrow inference across these
  // joined columns; cast to a hand-typed shape.
  type Row = {
    id: string;
    scheduled_at: string;
    status: string;
    voicemail_attempts: number;
    created_by: string | null;
    created_at: string;
    lead: {
      id: string;
      company: string | null;
      business_phone: string | null;
    } | null;
    campaign: { id: string; name: string } | null;
    originating_call_id: string | null;
    result_call_id: string | null;
  };
  const { data: rows } = await query;
  const callbacks = (rows ?? []) as unknown as Row[];

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Callbacks
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Scheduled redials. Pending callbacks auto-dial at their scheduled time
          when the dialer cron is active.
        </p>
      </div>

      <form
        method="get"
        action="/callbacks"
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex flex-col gap-2">
          <label
            htmlFor="cb-status"
            className="text-foreground text-sm font-medium"
          >
            Status
          </label>
          <Select name="status" defaultValue={statusFilter}>
            <SelectTrigger id="cb-status" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="missed">Missed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="cb-campaign"
            className="text-foreground text-sm font-medium"
          >
            Campaign
          </label>
          <Select name="campaign" defaultValue={campaignFilter || "__any__"}>
            <SelectTrigger id="cb-campaign" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">Any</SelectItem>
              {(campaigns ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="cb-from"
            className="text-foreground text-sm font-medium"
          >
            Scheduled from
          </label>
          <Input
            id="cb-from"
            name="from"
            type="date"
            defaultValue={fromFilter}
            className="w-44"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label
            htmlFor="cb-to"
            className="text-foreground text-sm font-medium"
          >
            Scheduled to
          </label>
          <Input
            id="cb-to"
            name="to"
            type="date"
            defaultValue={toFilter}
            className="w-44"
          />
        </div>

        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      {callbacks.length > 0 ? (
        <div className="border-border overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Scheduled</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>VM</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {callbacks.map((cb) => (
                <TableRow key={cb.id}>
                  <TableCell className="font-medium">
                    {cb.lead?.company ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {cb.lead?.business_phone ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {cb.campaign?.name ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {fmtDateTime(cb.scheduled_at)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        cb.status === "pending"
                          ? "default"
                          : cb.status === "completed"
                            ? "secondary"
                            : "outline"
                      }
                      dot
                    >
                      {STATUS_LABEL[cb.status] ?? cb.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {cb.voicemail_attempts > 0
                      ? `${cb.voicemail_attempts}`
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {cb.status === "pending" ? (
                      <CallbackRowActions
                        callbackId={cb.id}
                        currentScheduledAt={cb.scheduled_at}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <CalendarClock className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">
            No callbacks {statusFilter === "pending" ? "scheduled" : "match"}
          </p>
          <p className="text-muted-foreground text-sm">
            Callbacks are created by the agent during a call or manually from
            the call detail modal.
          </p>
        </div>
      )}
    </div>
  );
}
