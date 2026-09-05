"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  disableCloseInboundWebhook,
  disconnectClose,
  enableCloseInboundWebhook,
  saveCloseConnection,
} from "@/lib/close/actions";
import { etDateTime } from "@/lib/time/eastern";

export function CloseForm({
  connected,
  connectedAt,
  replyTracking,
  replyTrackingSince,
}: {
  connected: boolean;
  connectedAt: string | null;
  /** True when this user's Close webhook subscription exists (replies and
   *  STOP texts reach the app). */
  replyTracking: boolean;
  replyTrackingSince: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [key, setKey] = useState("");

  function run(
    action: () => Promise<{ error: string | null; warning?: string }>,
    ok: string,
  ) {
    startTransition(async () => {
      const r = await action();
      if (r.error) toast.error(r.error);
      else {
        if (r.warning) toast.warning(r.warning);
        else toast.success(ok);
        setKey("");
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {connected
          ? `Connected${connectedAt ? ` · since ${etDateTime(connectedAt, "", true)}` : ""}.`
          : "Not connected. Paste your Close API key to let the agent send emails and texts from your Close account. Connecting also turns on reply tracking."}
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
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={replyTracking ? "success" : "ghost"}
              dot
              data-testid="close-reply-tracking"
            >
              {replyTracking ? "Reply tracking on" : "Reply tracking off"}
            </Badge>
            <span className="text-muted-foreground text-xs">
              {replyTracking
                ? `Close sends replies and STOP texts here${replyTrackingSince ? ` · since ${etDateTime(replyTrackingSince, "", true)}` : ""}.`
                : "Replies and STOP texts from Close are not reaching the app. Enable it to get notified when a lead writes back and to honor STOP."}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(
                  enableCloseInboundWebhook,
                  replyTracking
                    ? "Reply tracking refreshed."
                    : "Reply tracking enabled.",
                )
              }
              data-testid="close-enable-replies"
            >
              {replyTracking
                ? "Refresh reply tracking"
                : "Enable reply tracking"}
            </Button>
            {replyTracking ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(disableCloseInboundWebhook, "Reply tracking turned off.")
                }
                data-testid="close-disable-replies"
              >
                Turn off
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => run(disconnectClose, "Close disconnected.")}
              data-testid="close-disconnect"
            >
              Disconnect
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
