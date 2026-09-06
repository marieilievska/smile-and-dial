"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

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
  disableCloseInboundWebhook,
  disconnectClose,
  enableCloseInboundWebhook,
  refreshCloseSmsNumbers,
  saveCloseConnection,
  setCloseSmsFromNumber,
} from "@/lib/close/actions";
import type { CloseSmsNumber } from "@/lib/close/sms-from-number";
import { etDateTime } from "@/lib/time/eastern";

export function CloseForm({
  connected,
  connectedAt,
  replyTracking,
  replyTrackingSince,
  smsFromNumber,
  smsNumbers,
}: {
  connected: boolean;
  connectedAt: string | null;
  /** True when this user's Close webhook subscription exists (replies and
   *  STOP texts reach the app). */
  replyTracking: boolean;
  replyTrackingSince: string | null;
  /** The Close number the agent texts from — chosen from `smsNumbers`, never
   *  typed in (owner decision, 2026-09-05: "whatever number we choose from
   *  Close directly"). */
  smsFromNumber: string | null;
  /** The SMS-capable numbers read from this user's Close account. */
  smsNumbers: CloseSmsNumber[];
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

  const current = smsNumbers.find((n) => n.number === smsFromNumber) ?? null;
  const describe = (n: CloseSmsNumber) =>
    n.label ? `${n.formatted} · ${n.label}` : n.formatted;

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
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="close-sms-number"
          >
            {smsNumbers.length === 0 ? (
              <span className="text-muted-foreground text-xs">
                No SMS-capable number found in Close. Add a Close number with
                texting enabled, then refresh.
              </span>
            ) : smsNumbers.length === 1 || !current ? (
              <span className="text-muted-foreground text-xs">
                Texts send from{" "}
                <span className="text-foreground font-medium">
                  {current ? describe(current) : describe(smsNumbers[0])}
                </span>
                .
              </span>
            ) : (
              <>
                <span className="text-muted-foreground text-xs">
                  Texts send from
                </span>
                <Select
                  value={current.number}
                  onValueChange={(value) =>
                    run(
                      () => setCloseSmsFromNumber(value),
                      "Texting number updated.",
                    )
                  }
                  disabled={pending}
                >
                  <SelectTrigger
                    className="h-8 w-[280px] text-xs"
                    aria-label="Texting number"
                    data-testid="close-sms-number-select"
                  >
                    <SelectValue placeholder="Choose a number" />
                  </SelectTrigger>
                  <SelectContent>
                    {smsNumbers.map((n) => (
                      <SelectItem key={n.number} value={n.number}>
                        {describe(n)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => run(refreshCloseSmsNumbers, "Numbers refreshed.")}
              data-testid="close-refresh-numbers"
            >
              Refresh numbers
            </Button>
          </div>
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
