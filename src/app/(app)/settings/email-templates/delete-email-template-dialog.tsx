"use client";

import { Trash2 } from "lucide-react";
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
import { deleteEmailTemplate } from "@/lib/email-templates/actions";

/** Delete an email template. Campaigns referencing it fall back to "no
 *  template" — the send_email tool then just records intent until a new one
 *  is chosen. */
export function DeleteEmailTemplateDialog({
  template,
  usageCount = 0,
}: {
  template: { id: string; name: string };
  usageCount?: number;
}) {
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      try {
        const result = await deleteEmailTemplate(template.id);
        if (result.error) toast.error(result.error);
        else toast.success("Template deleted.");
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Delete ${template.name}`}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete &ldquo;{template.name}&rdquo;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {usageCount > 0
              ? `${usageCount} campaign${usageCount === 1 ? "" : "s"} use this template — they'll fall back to sending no email until you pick another. `
              : ""}
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={pending}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
