"use client";

import { useTransition } from "react";
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
import { releaseNumber } from "@/lib/twilio/number-actions";

export function ReleaseNumberDialog({
  number,
}: {
  number: { id: string; phone_number: string };
}) {
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const result = await releaseNumber(number.id);
        if (result.error) toast.error(result.error);
        else toast.success("Number released.");
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        {/* Round 34 — aria-label keeps the raw E.164 to match the
         *  twilio-numbers Playwright contract; the dialog title
         *  reads from the same source so the heading and the screen
         *  reader label stay aligned. */}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Release ${number.phone_number}`}
        >
          Release
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Release {number.phone_number}?</AlertDialogTitle>
          <AlertDialogDescription>
            The number is given up at Twilio and stops being billed. It stays in
            this list for cost history. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={pending}>
            Release
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
