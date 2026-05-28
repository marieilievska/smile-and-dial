import { ShieldCheck, UserPlus, Users as UsersIcon } from "lucide-react";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

import { formatCreatedAt } from "../format-created";
import { InviteUserDialog } from "./invite-user-dialog";
import { UserRowActions } from "./user-row-actions";
import { UsersSearchInput } from "./users-search";
import { UsersStatusTabs } from "./users-status-tabs";

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
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

  const params = await searchParams;
  const status = ["active", "inactive", "all"].includes(str(params.status))
    ? str(params.status)
    : "active";
  const search = str(params.q).trim();

  // Pull every profile so we can compute the counts client-side.
  // The user table is small (workspace-scoped), so filtering in JS is
  // cheap and avoids two round-trips for counts + rows.
  const { data: rawUsers } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, active, created_at")
    .order("created_at", { ascending: true });
  const allUsers = rawUsers ?? [];

  const counts = {
    active: allUsers.filter((u) => u.active).length,
    inactive: allUsers.filter((u) => !u.active).length,
    all: allUsers.length,
  };

  const lowerSearch = search.toLowerCase();
  const visibleUsers = allUsers.filter((u) => {
    if (status === "active" && !u.active) return false;
    if (status === "inactive" && u.active) return false;
    if (lowerSearch) {
      const haystack = `${u.full_name ?? ""} ${u.email ?? ""}`.toLowerCase();
      if (!haystack.includes(lowerSearch)) return false;
    }
    return true;
  });

  function buildStatusHref(next: string): string {
    const url = new URLSearchParams();
    if (next && next !== "active") url.set("status", next);
    if (search) url.set("q", search);
    const qs = url.toString();
    return qs ? `/settings/users?${qs}` : "/settings/users";
  }

  const now = new Date();
  const adminCount = allUsers.filter((u) => u.role === "admin").length;

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Users
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Manage who can access the workspace.
          </p>
        </div>
        <InviteUserDialog />
      </div>

      <section
        data-testid="users-stat-strip"
        className="border-border bg-card grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border px-5 py-4 sm:grid-cols-3"
      >
        <StatTile
          icon={<UsersIcon className="size-3.5" />}
          label="Active"
          value={counts.active.toLocaleString()}
        />
        <StatTile
          icon={<UsersIcon className="size-3.5" />}
          label="Inactive"
          value={counts.inactive.toLocaleString()}
          divider
        />
        <StatTile
          icon={<ShieldCheck className="size-3.5" />}
          label="Admins"
          value={adminCount.toLocaleString()}
          divider
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <UsersStatusTabs
          current={status}
          counts={counts}
          buildHref={buildStatusHref}
        />
        <UsersSearchInput />
      </div>

      {visibleUsers.length > 0 ? (
        <div className="border-border overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleUsers.map((u) => (
                <TableRow key={u.id} className="group">
                  <TableCell className="font-medium">
                    {u.full_name || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{u.email}</TableCell>
                  <TableCell>
                    <Badge variant={u.role === "admin" ? "coral" : "secondary"}>
                      {u.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.active ? "success" : "secondary"} dot>
                      {u.active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground tabular-nums"
                    title={new Date(u.created_at).toLocaleString()}
                  >
                    {formatCreatedAt(u.created_at, now)}
                  </TableCell>
                  <TableCell>
                    <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <UserRowActions
                        userId={u.id}
                        email={u.email ?? ""}
                        name={u.full_name || u.email || "this user"}
                        role={u.role === "admin" ? "admin" : "member"}
                        active={u.active}
                        isSelf={u.id === user.id}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div
          data-testid="users-empty"
          className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center"
        >
          <UserPlus className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">
            {search || status !== "active"
              ? "No users match these filters"
              : "No users yet"}
          </p>
          <p className="text-muted-foreground max-w-sm text-sm">
            {search || status !== "active"
              ? "Widen the search or switch the status tab to see more."
              : "Invite teammates with the button above."}
          </p>
        </div>
      )}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  divider,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  divider?: boolean;
}) {
  return (
    <div
      className={`-mx-2 flex flex-col gap-1 rounded-lg px-2 py-1 ${
        divider ? "sm:border-border/60 sm:border-l sm:pl-4" : ""
      }`}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className="text-primary">{icon}</span>
        {label}
      </p>
      <p className="text-foreground text-2xl leading-none font-medium tabular-nums">
        {value}
      </p>
    </div>
  );
}
