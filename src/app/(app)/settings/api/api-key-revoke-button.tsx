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
import { revokeApiKey } from "@/lib/api-keys/actions";

export function ApiKeyRevokeButton({
  apiKeyId,
  keyName,
}: {
  apiKeyId: string;
  keyName?: string;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="api-key-revoke"
        >
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Revoke {keyName ? `“${keyName}”` : "this key"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Any integration using this key stops working immediately. This
            cannot be undone — create a new key and update the partner instead.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="api-key-revoke-confirm"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              startTransition(async () => {
                const r = await revokeApiKey({ apiKeyId });
                if (r.error) toast.error(r.error);
                else toast.success("Revoked.");
              });
            }}
          >
            {pending ? "Revoking…" : "Revoke key"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
