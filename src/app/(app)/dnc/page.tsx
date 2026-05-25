import { Ban } from "lucide-react";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { RemoveDncDialog } from "./remove-dnc-dialog";

const REASON_LABELS: Record<string, string> = {
  dnc_requested: "Caller requested",
  invalid_number: "Invalid number",
  language_barrier: "Language barrier",
  manual: "Manual",
  imported: "Imported",
};

const REASON_OPTIONS = Object.keys(REASON_LABELS);

function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function DncPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const params = await searchParams;
  const reasonFilter = REASON_OPTIONS.includes(str(params.reason))
    ? str(params.reason)
    : "";

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

  return (
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
        <AddDncDialog />
      </div>

      <form method="get" action="/dnc" className="flex items-end gap-2">
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
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>

      {entries.length > 0 ? (
        <div className="border-border overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
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
  );
}
