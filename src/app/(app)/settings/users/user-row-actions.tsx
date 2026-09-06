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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  assignableRoles,
  canActOnUser,
  ROLE_LABELS,
  type AppRole,
} from "@/lib/auth/roles";
import {
  deleteUser,
  resendInvite,
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
  actorRole,
  active,
  pendingInvite,
  isSelf,
}: {
  userId: string;
  email: string;
  name: string;
  /** The row's tier. */
  role: AppRole;
  /** The signed-in user's tier — decides which roles this row may be moved to,
   *  and whether it may be touched at all. Mirrors the profiles RLS guards:
   *  never yourself, and only a super admin may change a super admin. */
  actorRole: AppRole;
  active: boolean;
  /** True while they have never accepted the invitation. A password reset is
   *  the wrong instrument for that state -- they need a fresh invite link. */
  pendingInvite: boolean;
  isSelf: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const mayAct = canActOnUser(actorRole, role, isSelf);
  const roleChoices = assignableRoles(actorRole).filter((r) => r !== role);

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
          {mayAct && roleChoices.length > 0 ? (
            <>
              <DropdownMenuLabel>Change role</DropdownMenuLabel>
              {roleChoices.map((next) => (
                <DropdownMenuItem
                  key={next}
                  disabled={pending}
                  onSelect={() =>
                    run(
                      () => updateUserRole(userId, next),
                      `${name} is now ${ROLE_LABELS[next].toLowerCase()}.`,
                    )
                  }
                >
                  Make {ROLE_LABELS[next].toLowerCase()}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          {pendingInvite ? (
            <DropdownMenuItem
              disabled={pending}
              onSelect={() =>
                run(
                  () => resendInvite(userId),
                  `A new invitation is on its way to ${email}.`,
                )
              }
            >
              Resend invitation
            </DropdownMenuItem>
          ) : (
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
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!mayAct || pending}
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
          {!active && mayAct ? (
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
