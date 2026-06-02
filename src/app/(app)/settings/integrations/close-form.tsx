"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { disconnectClose, saveCloseConnection } from "@/lib/close/actions";

export function CloseForm({
  connected,
  connectedAt,
}: {
  connected: boolean;
  connectedAt: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [key, setKey] = useState("");

  function run(action: () => Promise<{ error: string | null }>, ok: string) {
    startTransition(async () => {
      const r = await action();
      if (r.error) toast.error(r.error);
      else {
        toast.success(ok);
        setKey("");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">
        {connected
          ? `Connected${connectedAt ? ` · since ${new Date(connectedAt).toLocaleString()}` : ""}.`
          : "Not connected. Paste your Close API key to let the agent send emails from your Close account."}
      </p>
      {!connected ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="password"
            autoComplete="off"
            placeholder="Close API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            data-testid="close-key"
          />
          <Button
            type="button"
            disabled={pending || !key.trim()}
            onClick={() =>
              run(() => saveCloseConnection(key), "Close connected.")
            }
            data-testid="close-connect"
          >
            Connect
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => run(disconnectClose, "Close disconnected.")}
          data-testid="close-disconnect"
        >
          Disconnect
        </Button>
      )}
    </div>
  );
}
