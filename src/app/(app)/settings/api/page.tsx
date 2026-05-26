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

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          API keys
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Create a key, paste it into your partner integration, and let them
          POST leads into your workspace.
        </p>
      </div>

      <Card>
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

      <Card>
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
                  <TableRow key={k.id}>
                    <TableCell className="font-medium">{k.name}</TableCell>
                    <TableCell className="font-mono text-xs">
                      sk_{k.key_prefix}…
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {k.last_used_at
                        ? new Date(k.last_used_at).toLocaleString()
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={k.revoked_at ? "destructive" : "secondary"}
                        dot
                      >
                        {k.revoked_at ? "revoked" : "active"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {!k.revoked_at ? (
                        <ApiKeyRevokeButton apiKeyId={k.id} />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documentation</CardTitle>
          <CardDescription>POST a lead to your workspace.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          <p className="text-foreground mb-2 font-semibold">Endpoint</p>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
            POST /api/v1/leads
          </pre>
          <p className="text-foreground mt-4 mb-2 font-semibold">Headers</p>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{`Authorization: Bearer sk_…
Content-Type: application/json
Idempotency-Key: <optional-uuid>`}</pre>
          <p className="text-foreground mt-4 mb-2 font-semibold">Body</p>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{`{
  "business_phone": "+18005551234",
  "company": "Acme Gym",
  "city": "Austin",
  "state": "TX",
  "business_email": "info@acmegym.com",
  "owner_name": "Pat Smith",
  "list": "January Partner Imports",
  "custom_fields": { "tier": "gold" }
}`}</pre>
          <p className="text-foreground mt-4 mb-2 font-semibold">Responses</p>
          <ul className="text-muted-foreground list-disc pl-5">
            <li>
              <code className="font-mono">201 Created</code> — new lead;
              response body has <code>id</code> + <code>status: created</code>
            </li>
            <li>
              <code className="font-mono">200 OK</code> — phone already exists;{" "}
              <code>id</code> + <code>status: duplicate</code>
            </li>
            <li>
              <code className="font-mono">400</code> — missing business_phone or
              invalid JSON
            </li>
            <li>
              <code className="font-mono">401</code> — missing or malformed key
            </li>
            <li>
              <code className="font-mono">403</code> — invalid or revoked key
            </li>
          </ul>
          <p className="text-foreground mt-4 mb-2 font-semibold">
            curl example
          </p>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">{`curl -X POST https://your.app/api/v1/leads \\
  -H "Authorization: Bearer sk_…" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"business_phone":"+18005551234","company":"Acme"}'`}</pre>
        </CardContent>
      </Card>
    </div>
  );
}
