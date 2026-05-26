import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

import { AutoRefresh } from "./auto-refresh";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

/** Severity is derived from kind rather than stored, so we don't have to
 *  retrofit existing rows. Anything not listed defaults to "info". */
const SEVERITY_BY_KIND: Record<string, "info" | "warn" | "error"> = {
  spend_cap_hit: "warn",
  spend_cap_resumed: "info",
  campaign_paused: "warn",
  number_flagged: "warn",
  connect_rate_low: "warn",
  webhook_error: "error",
  dialer_failure: "error",
  orphan_call: "error",
  integration_disconnected: "warn",
  goal_transition: "info",
  callback_changed: "info",
  outcome_override: "info",
  call_now: "info",
  dnc_removed: "info",
  merge_completed: "info",
};

const SEVERITY_FILTERS = ["any", "info", "warn", "error"] as const;
type Severity = (typeof SEVERITY_FILTERS)[number];

function severityFor(kind: string): "info" | "warn" | "error" {
  return SEVERITY_BY_KIND[kind] ?? "info";
}

function fmtDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

export default async function SystemHealthPage({
  searchParams,
}: {
  searchParams: Promise<{
    severity?: string;
    kind?: string;
    from?: string;
    to?: string;
    auto?: string;
  }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") redirect("/leads");

  const severity = (SEVERITY_FILTERS as readonly string[]).includes(
    str(params.severity),
  )
    ? (str(params.severity) as Severity)
    : "any";
  const kindFilter = str(params.kind).trim();
  const fromFilter = DATE_RE.test(str(params.from)) ? str(params.from) : "";
  const toFilter = DATE_RE.test(str(params.to)) ? str(params.to) : "";
  const auto = str(params.auto) === "1";

  let query = supabase
    .from("system_events")
    .select("id, kind, actor_user_id, ref_table, ref_id, payload, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (kindFilter) query = query.eq("kind", kindFilter);
  if (fromFilter) query = query.gte("created_at", `${fromFilter}T00:00:00`);
  if (toFilter) query = query.lte("created_at", `${toFilter}T23:59:59`);

  const { data: rawEvents } = await query;
  let events = rawEvents ?? [];

  // Severity is derived, not indexed — post-filter.
  if (severity !== "any") {
    events = events.filter((e) => severityFor(e.kind) === severity);
  }

  // Pull actor names for whichever events have one.
  const actorIds = Array.from(
    new Set(
      events.map((e) => e.actor_user_id).filter((id): id is string => !!id),
    ),
  );
  const actorName = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: actors } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("id", actorIds);
    for (const a of actors ?? []) {
      actorName.set(a.id, a.full_name || a.email || a.id.slice(0, 6));
    }
  }

  // Distinct kinds for the kind dropdown.
  const knownKinds = Array.from(new Set(events.map((e) => e.kind))).sort();

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          System Health
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Recent system events across the workspace. {events.length} shown (cap
          200). {auto ? "Auto-refreshing every 10s." : null}
        </p>
      </div>

      <form
        method="get"
        action="/system-health"
        className="flex flex-wrap items-end gap-2"
      >
        <input type="hidden" name="auto" value={auto ? "1" : "0"} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="sh-severity">Severity</Label>
          <Select name="severity" defaultValue={severity}>
            <SelectTrigger id="sh-severity" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITY_FILTERS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === "any" ? "Any" : s[0].toUpperCase() + s.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="sh-kind">Kind</Label>
          <Select name="kind" defaultValue={kindFilter || "__any__"}>
            <SelectTrigger id="sh-kind" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">Any</SelectItem>
              {knownKinds.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="sh-from">From</Label>
          <Input
            id="sh-from"
            name="from"
            type="date"
            defaultValue={fromFilter}
            className="w-44"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="sh-to">To</Label>
          <Input
            id="sh-to"
            name="to"
            type="date"
            defaultValue={toFilter}
            className="w-44"
          />
        </div>

        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <AutoRefresh enabled={auto} />

      {events.length > 0 ? (
        <div
          data-testid="system-events-table"
          className="border-border overflow-hidden rounded-lg border"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">When</TableHead>
                <TableHead className="w-24">Severity</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Ref</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Payload</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => {
                const sev = severityFor(e.kind);
                return (
                  <TableRow key={e.id} data-severity={sev}>
                    <TableCell className="text-muted-foreground text-xs">
                      {fmtDateTime(e.created_at)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          sev === "error"
                            ? "destructive"
                            : sev === "warn"
                              ? "default"
                              : "secondary"
                        }
                      >
                        {sev}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {e.kind}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {e.ref_table
                        ? `${e.ref_table}/${(e.ref_id ?? "—").slice(0, 8)}`
                        : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {e.actor_user_id
                        ? (actorName.get(e.actor_user_id) ?? "—")
                        : "system"}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-md truncate font-mono text-xs">
                      {e.payload ? JSON.stringify(e.payload) : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <p className="text-foreground text-sm font-medium">
            No system events match your filters.
          </p>
          <p className="text-muted-foreground text-sm">
            Events are written by the dialer, the spend-cap monitor, the
            connect-rate monitor, manual outcome overrides, and the merge /
            cancel flows.
          </p>
        </div>
      )}
    </div>
  );
}
