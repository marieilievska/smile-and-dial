"use client";

import { useTransition } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
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
import {
  deleteCustomField,
  moveCustomField,
  type FieldActionResult,
} from "@/lib/custom-fields/actions";

import { CustomFieldDialog, type CustomFieldData } from "./custom-field-dialog";

export function CustomFieldRowActions({
  field,
  isFirst,
  isLast,
}: {
  field: CustomFieldData;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<FieldActionResult>, success?: string) {
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) toast.error(result.error);
        else if (success) toast.success(success);
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${field.name} up`}
        disabled={isFirst || pending}
        onClick={() => run(() => moveCustomField(field.id, "up"))}
      >
        <ArrowUp className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${field.name} down`}
        disabled={isLast || pending}
        onClick={() => run(() => moveCustomField(field.id, "down"))}
      >
        <ArrowDown className="size-4" />
      </Button>
      <CustomFieldDialog mode="edit" field={field} />
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={`Delete ${field.name}`}>
            <Trash2 className="size-4" />
            Delete
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &ldquo;{field.name}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the field from every lead. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                run(() => deleteCustomField(field.id), "Field deleted.")
              }
              disabled={pending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
