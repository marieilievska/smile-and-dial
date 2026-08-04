"use client";

import { Ban, MoreHorizontal, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { bulkAddLeadsToDnc } from "@/lib/dnc/actions";
import { bulkDeleteLeads } from "@/lib/leads/bulk-actions";

/** Low-frequency, destructive lead actions (Mark do-not-call, Delete) tucked
 *  into a "More" overflow menu so the hero leads with the call actions. Each
 *  opens a styled confirm dialog — consistent with the rest of the app, and no
 *  raw window.confirm popup on the one page where you'd delete a lead. DNC
 *  refreshes in place; Delete returns to /leads. */
export function LeadHeroActions({
  leadId,
  leadName,
}: {
  leadId: string;
  leadName: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<null | "dnc" | "delete">(null);
  const friendlyName = leadName?.trim() || "this lead";

  function markDnc() {
    startTransition(async () => {
      const result = await bulkAddLeadsToDnc({ leadIds: [leadId] });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Added to do-not-call.");
        setDialog(null);
        router.refresh();
      }
    });
  }

  function softDelete() {
    startTransition(async () => {
      const result = await bulkDeleteLeads({ leadIds: [leadId] });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Lead deleted.");
        router.push("/leads");
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="More actions"
            disabled={pending}
          >
            <MoreHorizontal className="size-4" />
            More
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => setDialog("dnc")}>
            <Ban className="size-4" />
            Mark do not call
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setDialog("delete")}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="size-4" />
            Delete lead
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={dialog === "dnc"}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Mark {friendlyName} as do not call?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The dialer will never call this number again, across any campaign.
              An admin can remove it from the do-not-call list later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                markDnc();
              }}
              disabled={pending}
            >
              {pending ? "Marking…" : "Mark do not call"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={dialog === "delete"}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {friendlyName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the lead from your lists and the calling queue. It
              can be restored by an admin if you change your mind.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                softDelete();
              }}
              disabled={pending}
            >
              {pending ? "Deleting…" : "Delete lead"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
