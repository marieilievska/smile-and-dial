"use client";

import { AlertCircle } from "lucide-react";
import { useActionState, useState } from "react";

import { PasswordStrength } from "@/components/auth/password-strength";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { setPassword, type SetPasswordState } from "@/lib/auth/actions";

export function SetPasswordForm() {
  const [state, formAction, pending] = useActionState<
    SetPasswordState,
    FormData
  >(setPassword, null);

  // Track the new-password value client-side so the strength meter can
  // update on each keystroke. The server action still reads the real
  // form value — this state is purely cosmetic.
  const [pwd, setPwd] = useState("");

  return (
    <div className="flex flex-col gap-8">
      <div className="animate-in fade-in slide-in-from-bottom-2 flex flex-col gap-2 duration-500">
        <h2 className="text-foreground text-2xl font-semibold tracking-tight">
          Welcome to Smile &amp; Dial
        </h2>
        <p className="text-muted-foreground text-sm">
          Pick a password to finish setting up your account.
        </p>
      </div>

      <form
        action={formAction}
        className="animate-in fade-in slide-in-from-bottom-2 flex flex-col gap-5 duration-500"
        style={{ animationDelay: "120ms", animationFillMode: "both" }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="password">New password</Label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={8}
            autoFocus
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
          />
          <PasswordStrength value={pwd} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <PasswordInput
            id="confirm"
            name="confirm"
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
