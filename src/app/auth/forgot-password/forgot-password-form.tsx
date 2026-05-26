"use client";

import { AlertCircle, ArrowLeft, MailCheck } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgotPassword, type ForgotPasswordState } from "@/lib/auth/actions";

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState<
    ForgotPasswordState,
    FormData
  >(forgotPassword, { kind: "idle" });

  // Success state — show a calm confirmation, no input. Same copy
  // regardless of whether the email actually exists (Supabase
  // intentionally doesn't tell us — prevents account enumeration).
  if (state?.kind === "sent") {
    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            <MailCheck className="size-7" />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-foreground text-2xl font-semibold tracking-tight">
              Check your email
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              If that address is on the account, a reset link is on its way.
              Open it from the same browser and you&apos;ll pick a new password
              on the next screen.
            </p>
          </div>
        </div>
        <Button asChild variant="outline" className="w-full">
          <Link href="/login">
            <ArrowLeft className="size-4" />
            Back to sign in
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h2 className="text-foreground text-2xl font-semibold tracking-tight">
          Reset your password
        </h2>
        <p className="text-muted-foreground text-sm">
          We&apos;ll email you a one-time link to choose a new one.
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
          />
        </div>

        {state?.kind === "error" ? (
          <div
            role="alert"
            className="border-destructive/30 bg-destructive/5 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2 text-sm"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p>{state.error}</p>
          </div>
        ) : null}

        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Sending…" : "Send reset link"}
        </Button>

        <Link
          href="/login"
          className="text-muted-foreground hover:text-foreground inline-flex items-center justify-center gap-1.5 text-sm"
        >
          <ArrowLeft className="size-3.5" />
          Back to sign in
        </Link>
      </form>
    </div>
  );
}
