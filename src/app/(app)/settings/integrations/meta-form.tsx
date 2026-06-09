"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectMeta, disconnectMeta, syncMetaNow } from "@/lib/meta/actions";

export function MetaForm({
  connected,
  lastSyncAt,
  lastSyncCount,
  lastSyncError,
}: {
  connected: boolean;
  lastSyncAt: string | null;
  lastSyncCount: number;
  lastSyncError: string | null;
}) {
  const [adAccountId, setAdAccountId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, startTransition] = useTransition();

  function connect() {
    startTransition(async () => {
      const r = await connectMeta({ adAccountId, accessToken, acknowledged });
      if (r.error) toast.error(r.error);
      else {
        toast.success("Meta connected. Run a sync to push your audience.");
        setAccessToken("");
      }
    });
  }
  function disconnect() {
    startTransition(async () => {
      const r = await disconnectMeta();
      if (r.error) toast.error(r.error);
      else toast.success("Meta disconnected.");
    });
  }
  function syncNow() {
    startTransition(async () => {
      const r = await syncMetaNow();
      if (r.error) toast.error(r.error);
      else toast.success("Sync complete.");
    });
  }

  if (connected) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-sm">
          {lastSyncError
            ? `Last sync error: ${lastSyncError} — reconnect may be needed.`
            : lastSyncAt
              ? `Last synced ${new Date(lastSyncAt).toLocaleString()} · ${lastSyncCount.toLocaleString()} contacts`
              : "Connected. Not synced yet."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={pending}
            onClick={syncNow}
            data-testid="meta-sync"
          >
            {pending ? "Working…" : "Sync now"}
          </Button>
          <Button asChild variant="outline" data-testid="meta-export">
            <a href="/settings/integrations/meta/export">Export CSV</a>
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={disconnect}
            data-testid="meta-disconnect"
          >
            Disconnect
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Not connected. Paste your Meta ad account ID and a system-user access
        token to sync collected lead emails into a Custom Audience. Emails are
        hashed before they leave the server.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="meta-acct">Ad account ID</Label>
        <Input
          id="meta-acct"
          autoComplete="off"
          placeholder="act_123456789"
          value={adAccountId}
          onChange={(e) => setAdAccountId(e.target.value)}
          data-testid="meta-acct"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="meta-token">System user access token</Label>
        <Input
          id="meta-token"
          type="password"
          autoComplete="off"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          data-testid="meta-token"
        />
      </div>
      <label className="flex items-start gap-2 text-xs">
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(v) => setAcknowledged(v === true)}
          className="mt-0.5"
          data-testid="meta-acknowledge"
        />
        <span className="text-muted-foreground">
          I confirm we have the right to use these contacts for advertising
          (Meta Custom Audience Terms).
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={pending}
          onClick={connect}
          data-testid="meta-connect"
        >
          {pending ? "Connecting…" : "Connect Meta"}
        </Button>
        <Button asChild variant="outline" data-testid="meta-export">
          <a href="/settings/integrations/meta/export">Export CSV</a>
        </Button>
      </div>
    </div>
  );
}
