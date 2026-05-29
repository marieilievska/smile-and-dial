"use client";

import { AlertCircle, ArrowLeft, MailCheck } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { forgotPassword, type ForgotPasswordState } from "@/lib/auth/actions";

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState<
    ForgotPasswordState,
    FormData
  >(forgotPassword, { kind: "idle" });

  if (state?.kind === "sent") {
    return <SentState />;
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="animate-in fade-in slide-in-from-bottom-2 flex flex-col gap-2 duration-500">
        <h2 className="text-foreground text-2xl font-semibold tracking-tight">
          Reset your password
        </h2>
        <p className="text-muted-foreground text-sm">
          We&apos;ll email you a one-time link to choose a new one.
        </p>
      </div>

      <form
        action={formAction}
        className="animate-in fade-in slide-in-from-bottom-2 flex flex-col gap-5 duration-500"
        style={{ animationDelay: "120ms", animationFillMode: "both" }}
      >
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

/** "Check your email" success state. Calm but with a few delightful
 *  touches: the envelope icon fades + scales in, a 30-second resend
 *  cooldown ticks down so the user knows when they can try again, and
 *  the copy doesn't reveal whether the email actually exists (Supabase
 *  deliberately doesn't tell us — prevents account enumeration). */
function SentState() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col items-center gap-5 text-center">
        <div
          className="animate-in fade-in zoom-in-50 flex size-16 items-center justify-center rounded-full duration-500"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--primary) 18%, transparent)",
            color: "var(--primary)",
          }}
        >
          <MailCheck className="size-8" />
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-foreground text-2xl font-semibold tracking-tight">
            Check your email
          </h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            If that address is on the account, a reset link is on its way. Open
            it from the same browser and you&apos;ll pick a new password on the
            next screen.
          </p>
        </div>
      </div>

      <ResendBlock />

      <Button asChild variant="outline" className="w-full">
        <Link href="/login">
          <ArrowLeft className="size-4" />
          Back to sign in
        </Link>
      </Button>
    </div>
  );
}

/** 30-second countdown before "Send another" is enabled. Pure UX —
 *  the underlying server action is rate-limited by Supabase regardless,
 *  but the visible timer sets the user's expectation. */
function ResendBlock() {
  const [seconds, setSeconds] = useState(30);

  useEffect(() => {
    if (seconds <= 0) return;
    const id = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [seconds]);

  if (seconds > 0) {
    return (
      <p className="text-muted-foreground text-center text-xs">
        Didn&apos;t get it? You can try again in{" "}
        <span className="text-foreground font-mono tabular-nums">
          {seconds}s
        </span>
        .
      </p>
    );
  }

  return (
    <p className="text-muted-foreground text-center text-xs">
      Didn&apos;t get it?{" "}
      <Link
        href="/auth/forgot-password"
        className="text-foreground underline-offset-2 hover:underline"
      >
        Send another link
      </Link>
      .
    </p>
  );
}
