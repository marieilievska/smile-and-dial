"use client";

import { useTransition } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
