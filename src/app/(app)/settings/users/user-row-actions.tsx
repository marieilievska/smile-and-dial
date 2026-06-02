"use client";

import { useState, useTransition } from "react";
import { MoreHorizontal } from "lucide-react";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  deleteUser,
  sendPasswordReset,
  setUserActive,
  updateUserRole,
  type ActionResult,
} from "@/lib/users/actions";

export function UserRowActions({
  userId,
  email,
  name,
  role,
  active,
  isSelf,
}: {
  userId: string;
  email: string;
  name: string;
  role: "admin" | "member";
  active: boolean;
  isSelf: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const nextRole = role === "admin" ? "member" : "admin";

  function run(action: () => Promise<ActionResult>, success: string) {
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) toast.error(result.error);
        else toast.success(success);
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${name}`}
            disabled={pending}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={isSelf || pending}
            onSelect={() =>
              run(
                () => updateUserRole(userId, nextRole),
                `${name} is now ${nextRole === "admin" ? "an admin" : "a member"}.`,
              )
            }
          >
            Make {nextRole}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={pending}
            onSelect={() =>
              run(
                () => sendPasswordReset(email),
                `Password-reset email sent to ${email}.`,
              )
            }
          >
            Send password reset
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={isSelf || pending}
            onSelect={() =>
              run(
                () => setUserActive(userId, !active),
                active
                  ? `${name} has been deactivated.`
                  : `${name} has been reactivated.`,
              )
            }
          >
            {active ? "Deactivate" : "Reactivate"}
          </DropdownMenuItem>
          {/* Delete is only offered for already-deactivated accounts, so the
              flow is always deactivate → delete. */}
          {!active && !isSelf ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={pending}
                onSelect={(e) => {
                  e.preventDefault();
                  setConfirmOpen(true);
                }}
              >
                Delete user
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes {email}&apos;s login and everything they
              own (their lists, leads, calls, agents, and campaigns). This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() =>
                run(() => deleteUser(userId), `${name} has been deleted.`)
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
