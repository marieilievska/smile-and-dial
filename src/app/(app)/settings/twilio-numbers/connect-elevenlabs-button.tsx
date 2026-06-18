"use client";

import { Cloud, Loader2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { connectNumberToElevenLabs } from "@/lib/twilio/number-actions";

/** Per-number "Connect to ElevenLabs" — registers this Twilio number with
 *  ElevenLabs for outbound dialing (caches its phone_number_id). The visible
 *  repair path when the on-attach auto-register failed, or for numbers attached
 *  before that existed. */
export function ConnectElevenLabsButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      try {
        const result = await connectNumberToElevenLabs(id);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success("Connected to ElevenLabs.");
        }
      } catch {
        toast.error("Connect failed. Try again in a moment.");
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
      aria-label="Connect this number to ElevenLabs"
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Cloud className="size-3.5" />
      )}
      {pending ? "Connecting…" : "Connect EL"}
    </Button>
  );
}
