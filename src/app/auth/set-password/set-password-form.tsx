"use client";

import { AlertCircle, Lock } from "lucide-react";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setPassword, type SetPasswordState } from "@/lib/auth/actions";

export function SetPasswordForm() {
  const [state, formAction, pending] = useActionState<
    SetPasswordState,
    FormData
  >(setPassword, null);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h2 className="text-foreground text-2xl font-semibold tracking-tight">
          Welcome to Smile &amp; Dial
        </h2>
        <p className="text-muted-foreground text-sm">
          Pick a password to finish setting up your account.
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            autoFocus
          />
          <p className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <Lock className="size-3" />
            At least 8 characters
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
          />
        </div>

        {state?.error ? (
          <div
            role="alert"
            className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>{state.error}</p>
          </div>
        ) : null}

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Saving…" : "Set password and continue"}
        </Button>
      </form>
    </div>
  );
}
