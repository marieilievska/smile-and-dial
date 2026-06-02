"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  disconnectCalendly,
  saveCalendlyConnection,
  syncCalendly,
} from "@/lib/calendly/actions";

export function CalendlyForm({
  connected,
  lastSyncAt,
  eventTypeCount,
}: {
  connected: boolean;
  lastSyncAt: string | null;
  eventTypeCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const [token, setToken] = useState("");

  function run(action: () => Promise<{ error: string | null }>, ok: string) {
    startTransition(async () => {
      const r = await action();
      if (r.error) toast.error(r.error);
      else {
        toast.success(ok);
        setToken("");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">
        {connected
          ? `Connected${lastSyncAt ? ` · last synced ${new Date(lastSyncAt).toLocaleString()}` : ""} · ${eventTypeCount} event type${eventTypeCount === 1 ? "" : "s"}.`
          : "Not connected. Paste your Calendly Personal Access Token to let the agent read your availability and book meetings on your calendar."}
      </p>
      {!connected ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="password"
            autoComplete="off"
            placeholder="Calendly Personal Access Token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            data-testid="calendly-token"
          />
          <Button
            type="button"
            disabled={pending || !token.trim()}
            onClick={() =>
              run(() => saveCalendlyConnection(token), "Calendly connected.")
            }
            data-testid="calendly-connect"
          >
            Connect
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => run(syncCalendly, "Synced.")}
            data-testid="calendly-sync"
          >
            Sync now
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => run(disconnectCalendly, "Calendly disconnected.")}
            data-testid="calendly-disconnect"
          >
            Disconnect
          </Button>
        </div>
      )}
    </div>
  );
}
