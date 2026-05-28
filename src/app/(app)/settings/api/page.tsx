import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { ApiDocsTabs } from "./api-docs-tabs";
import { ApiKeyCreateForm } from "./api-key-create-form";
import { ApiKeyRevokeButton } from "./api-key-revoke-button";

export default async function ApiPage() {
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
  if (me?.role !== "admin") redirect("/settings");

  const { data: keys } = await supabase
    .from("api_keys")
    .select("id, name, key_prefix, created_at, last_used_at, revoked_at")
    .order("created_at", { ascending: false });

  const now = new Date();

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="duration-500">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          API keys
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Create a key, paste it into your partner integration, and let them
          POST leads into your workspace.
        </p>
      </div>

      <Card className="delay-75">
        <CardHeader>
          <CardTitle>Create a new key</CardTitle>
          <CardDescription>
            The full key is shown once. Copy it immediately — we only keep its
            hash.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ApiKeyCreateForm />
        </CardContent>
      </Card>

      <Card className="delay-150">
        <CardHeader>
          <CardTitle>Active keys</CardTitle>
        </CardHeader>
        <CardContent>
          {(keys ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No keys yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(keys ?? []).map((k) => (
                  <TableRow key={k.id} className="group">
                    <TableCell className="font-medium">{k.name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      sk_{k.key_prefix}…
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground text-xs tabular-nums"
                      title={
                        k.last_used_at
                          ? new Date(k.last_used_at).toLocaleString()
                          : undefined
                      }
                    >
                      {k.last_used_at
                        ? formatCreatedAt(k.last_used_at, now)
                        : "Never"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={k.revoked_at ? "destructive" : "success"}
                        dot
                      >
                        {k.revoked_at ? "Revoked" : "Active"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        {!k.revoked_at ? (
                          <ApiKeyRevokeButton apiKeyId={k.id} />
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="delay-200">
        <CardHeader>
          <CardTitle>Documentation</CardTitle>
          <CardDescription>POST a lead to your workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <ApiDocsTabs />
        </CardContent>
      </Card>
    </div>
  );
}
