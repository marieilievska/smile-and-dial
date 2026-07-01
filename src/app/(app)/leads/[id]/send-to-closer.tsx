"use client";

import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { handoffLeadToClose } from "@/lib/close/actions";
import { exactDateTime, relativeTime } from "@/lib/relative-time";

export type HandoffInfo = { at: string; byName: string | null } | null;

/** Admin-only "Send to closer" action on the lead detail page: pushes the lead
 *  + a context note into the owner's Close CRM. Shows when it was last handed
 *  off (from the lead_handoff audit event). Re-clicking re-sends a fresh note. */
export function SendToCloserButton({
  leadId,
  handoff,
}: {
  leadId: string;
  handoff: HandoffInfo;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick() {
    const confirmMsg = handoff
      ? "This lead was already handed off. Re-send an updated note to Close?"
      : "Send this lead to the closer in Close?";
    if (!window.confirm(confirmMsg)) return;
    startTransition(async () => {
      const res = await handoffLeadToClose(leadId);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Sent to closer in Close.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={pending}
      >
        <Send className="size-4" />
        {pending ? "Sending…" : "Send to closer"}
      </Button>
      {handoff ? (
        <span
          className="text-muted-foreground text-xs"
          title={exactDateTime(handoff.at)}
        >
          Handed off {relativeTime(handoff.at)}
          {handoff.byName ? ` by ${handoff.byName}` : ""}
        </span>
      ) : null}
    </div>
  );
}
