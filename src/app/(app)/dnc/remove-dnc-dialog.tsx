"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { removeFromDnc } from "@/lib/dnc/actions";

export function RemoveDncDialog({ phone }: { phone: string }) {
  const [open, setOpen] = useState(false);
  const [reasonText, setReasonText] = useState("");
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await removeFromDnc({ phone, reasonText });
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Removed from DNC.");
        setOpen(false);
        setReasonText("");
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove ${phone} from DNC`}
        >
          <Trash2 className="size-4" />
          Remove
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {phone} from DNC?</AlertDialogTitle>
          <AlertDialogDescription>
            Required: write a short reason. It&apos;s logged to the audit trail
            and cannot be edited later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="dnc-reason-text">Reason</Label>
          <Textarea
            id="dnc-reason-text"
            value={reasonText}
            onChange={(event) => setReasonText(event.target.value)}
            rows={3}
            placeholder="Why is this number coming off the DNC list?"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || !reasonText.trim()}
            onClick={confirm}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
