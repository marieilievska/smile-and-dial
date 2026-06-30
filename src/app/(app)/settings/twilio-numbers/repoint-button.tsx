"use client";

import { Loader2, Webhook } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { repointNumberWebhooks } from "@/lib/twilio/number-actions";

/** Per-row "Point to ElevenLabs" button. Repoints a number's Twilio voice +
 *  status webhooks at ElevenLabs' native inbound endpoints — the recovery path
 *  when a number's routing drifted back at the app (which breaks inbound) or the
 *  purchase-time pointing failed. Sends a single IncomingPhoneNumbers PATCH to
 *  Twilio and updates the stored webhook columns. */
export function RepointWebhooksButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      try {
        const result = await repointNumberWebhooks(id);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success("Pointed at ElevenLabs.");
        }
      } catch {
        toast.error("Repoint failed. Try again in a moment.");
      }
    });
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={pending}
      aria-label="Point webhooks at ElevenLabs"
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Webhook className="size-3.5" />
      )}
      {pending ? "Pointing…" : "Point to ElevenLabs"}
    </Button>
  );
}
