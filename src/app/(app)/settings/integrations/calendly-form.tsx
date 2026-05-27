"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  connectCalendlyMock,
  disconnectCalendly,
  syncCalendlyMock,
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
          ? `Connected${lastSyncAt ? ` · last synced ${new Date(lastSyncAt).toLocaleString()}` : ""} · ${eventTypeCount} event type${eventTypeCount === 1 ? "" : "s"}.`
          : "Not connected. Connect to enable the get_available_times and book_appointment agent tools."}
      </p>
      <div className="flex gap-2">
        {!connected ? (
          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              withToast(connectCalendlyMock, "Calendly connected.")
            }
            data-testid="calendly-connect"
          >
            Connect Calendly (mock)
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => withToast(syncCalendlyMock, "Synced.")}
              data-testid="calendly-sync"
            >
              Sync now
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                withToast(disconnectCalendly, "Calendly disconnected.")
              }
              data-testid="calendly-disconnect"
            >
              Disconnect
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
