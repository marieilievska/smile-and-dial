"use client";

import { Ban, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { bulkAddLeadsToDnc } from "@/lib/dnc/actions";
import { bulkDeleteLeads } from "@/lib/leads/bulk-actions";

/** Destructive actions surfaced at the top of the lead detail page.
 *  Mirrors the kebab items on the leads-list row, but as visible
 *  outline buttons because the detail page is the place you'd act
 *  on a single lead — hiding them inside a menu means an extra click
 *  every time. After either action the user is bounced back to
 *  /leads since the current lead either no longer exists or has
 *  been moved out of normal outbound queues. */
export function LeadHeroActions({
  leadId,
  leadName,
}: {
  leadId: string;
  leadName: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const friendlyName = leadName?.trim() || "this lead";

  function markDnc() {
    if (!confirm(`Mark ${friendlyName} as Do Not Call?`)) return;
    startTransition(async () => {
      const result = await bulkAddLeadsToDnc({ leadIds: [leadId] });
      if (result.error) toast.error(result.error);
      else {
        toast.success("Added to DNC.");
        router.refresh();
      }
    });
  }

  function softDelete() {
    if (!confirm(`Delete ${friendlyName}? This can be restored.`)) return;
    startTransition(async () => {
      const result = await bulkDeleteLeads({ leadIds: [leadId] });
      if (result.error) toast.error(result.error);
      else {
        toast.success("Lead deleted.");
        router.push("/leads");
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={markDnc}
        disabled={pending}
        className="text-destructive hover:text-destructive border-destructive/40 hover:bg-destructive/10"
      >
        <Ban className="size-4" />
        Mark DNC
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={softDelete}
        disabled={pending}
        className="text-destructive hover:text-destructive border-destructive/40 hover:bg-destructive/10"
      >
        <Trash2 className="size-4" />
        Delete
      </Button>
    </>
  );
}
