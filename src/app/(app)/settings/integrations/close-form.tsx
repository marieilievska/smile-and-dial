"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { connectCloseMock, disconnectClose } from "@/lib/close/actions";

export function CloseForm({
  connected,
  connectedAt,
}: {
  connected: boolean;
  connectedAt: string | null;
}) {
  const [pending, startTransition] = useTransition();
  function withToast(
    action: () => Promise<{ error: string | null }>,
    ok: string,
  ) {
    startTransition(async () => {
      const r = await action();
      if (r.error) toast.error(r.error);
      else toast.success(ok);
    });
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">
        {connected
          ? `Connected${connectedAt ? ` · since ${new Date(connectedAt).toLocaleString()}` : ""}.`
          : "Not connected. Connect to enable the send_email agent tool and the email_replied inbound webhook."}
      </p>
      <div className="flex gap-2">
        {!connected ? (
          <Button
            type="button"
            disabled={pending}
            onClick={() => withToast(connectCloseMock, "Close connected.")}
            data-testid="close-connect"
          >
            Connect Close (mock)
          </Button>
        ) : (
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => withToast(disconnectClose, "Close disconnected.")}
            data-testid="close-disconnect"
          >
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}
