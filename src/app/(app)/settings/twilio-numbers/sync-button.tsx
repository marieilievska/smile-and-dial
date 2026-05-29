"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { syncFromTwilio } from "@/lib/twilio/number-actions";

/** Round L2 — "Sync from Twilio" pulls the full IncomingPhoneNumbers
 *  list from the account and reconciles into our `twilio_numbers`
 *  table. Numbers we don't have yet get inserted (so admins can see
 *  every number they pay for, not just the ones bought through the
 *  app); numbers we already have get their webhook URLs refreshed
 *  from Twilio so drift surfaces in the UI. */
export function TwilioSyncButton() {
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      try {
        const result = await syncFromTwilio();
        if (result.error) {
          toast.error(result.error);
          return;
        }
        const parts: string[] = [];
        if (result.added) {
          parts.push(`${result.added} new`);
        }
        if (result.refreshed) {
          parts.push(`${result.refreshed} refreshed`);
        }
        toast.success(
          parts.length === 0
            ? "Already in sync — no changes."
            : `Sync complete (${parts.join(" · ")}).`,
        );
      } catch {
        toast.error("Sync failed. Try again in a moment.");
      }
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      disabled={pending}
      aria-label="Sync numbers from Twilio"
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <RefreshCw className="size-4" />
      )}
      {pending ? "Syncing…" : "Sync from Twilio"}
    </Button>
  );
}
