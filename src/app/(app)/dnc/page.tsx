import { Ban, Upload } from "lucide-react";
import Link from "next/link";
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

import { AddDncDialog } from "./add-dnc-dialog";
import { DncBulkActionBar } from "./bulk-action-bar";
import { RemoveDncDialog } from "./remove-dnc-dialog";
import { RowCheckbox, SelectAllCheckbox, SelectionProvider } from "./selection";

const REASON_LABELS: Record<string, string> = {
  dnc_requested: "Caller requested",
  invalid_number: "Invalid number",
  language_barrier: "Language barrier",
  manual: "Manual",
  imported: "Imported",
};

const REASON_OPTIONS = Object.keys(REASON_LABELS);

// Accepts yyyy-mm-dd, returns the same string. Invalid input becomes "".
function dateStr(value: string | string[] | undefined): string {
  const s = typeof value === "string" ? value : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function DncPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const reasonFilter = REASON_OPTIONS.includes(str(params.reason))
    ? str(params.reason)
    : "";
  const fromFilter = dateStr(params.from);
  const toFilter = dateStr(params.to);

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
  const isAdmin = me?.role === "admin";

  let query = supabase
    .from("dnc_entries")
    .select("id, phone, company_snapshot, reason, added_by_user_id, added_at")
    .order("added_at", { ascending: false });
  if (reasonFilter) query = query.eq("reason", reasonFilter);
  if (fromFilter) query = query.gte("added_at", fromFilter);
  if (toFilter) query = query.lte("added_at", `${toFilter}T23:59:59.999Z`);

  const { data: rawEntries } = await query;
  const entries = rawEntries ?? [];

  const userIds = [
    ...new Set(
      entries
        .map((e) => e.added_by_user_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const userName = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("id", userIds);
    for (const profile of profiles ?? []) {
      userName.set(profile.id, profile.full_name || profile.email || "—");
    }
  }

  const rowsForSelection = entries.map((e) => ({ id: e.id, phone: e.phone }));

  return (
    <SelectionProvider allRows={rowsForSelection}>
      <div className="flex flex-col gap-6 p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-foreground text-2xl font-bold tracking-tight">
              Do not call
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Workspace-wide list of phone numbers the dialer must skip.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
              <Link href="/dnc/import">
                <Upload className="size-4" />
                Import
              </Link>
            </Button>
            <AddDncDialog />
          </div>
        </div>

        <form
          method="get"
          action="/dnc"
          className="flex flex-wrap items-end gap-2"
        >
          <div className="flex flex-col gap-2">
            <label
              htmlFor="dnc-reason-filter"
              className="text-foreground text-sm font-medium"
            >
              Reason
            </label>
            <Select name="reason" defaultValue={reasonFilter || "__all__"}>
              <SelectTrigger id="dnc-reason-filter" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All reasons</SelectItem>
                {REASON_OPTIONS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {REASON_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <label
              htmlFor="dnc-from-filter"
              className="text-foreground text-sm font-medium"
            >
              Added from
            </label>
            <Input
              id="dnc-from-filter"
              name="from"
              type="date"
              defaultValue={fromFilter}
              className="w-44"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label
              htmlFor="dnc-to-filter"
              className="text-foreground text-sm font-medium"
            >
              Added to
            </label>
            <Input
              id="dnc-to-filter"
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

        <DncBulkActionBar isAdmin={isAdmin} />

        {entries.length > 0 ? (
          <div className="border-border overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <SelectAllCheckbox />
                  </TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Added by</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>
                      <RowCheckbox id={entry.id} phone={entry.phone} />
                    </TableCell>
                    <TableCell className="font-mono text-xs font-medium">
                      {entry.phone}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.company_snapshot || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {REASON_LABELS[entry.reason] ?? entry.reason}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.added_by_user_id
                        ? (userName.get(entry.added_by_user_id) ?? "—")
                        : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(entry.added_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      {isAdmin ? (
                        <div className="flex justify-end">
                          <RemoveDncDialog phone={entry.phone} />
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
            <Ban className="text-muted-foreground size-8" />
            <p className="text-foreground text-sm font-medium">
              No numbers on DNC
            </p>
            <p className="text-muted-foreground text-sm">
              Numbers added here are blocked at dial time.
            </p>
          </div>
        )}
      </div>
    </SelectionProvider>
  );
}
