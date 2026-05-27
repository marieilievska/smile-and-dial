import { MailX } from "lucide-react";
import Link from "next/link";

import { AuthSingleColumn } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";

export default function AuthErrorPage() {
  return (
    <AuthSingleColumn>
      <div className="border-border bg-card flex flex-col items-center gap-6 rounded-2xl border p-10 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          <MailX className="size-7" />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">
            That link has expired.
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Invitation and password-reset links are one-shot and time out after
            a while. Ask your admin for a fresh invite — no harm done.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2">
          <Button asChild className="w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="mailto:marketing@referrizer.com">
              Email the platform admin
            </Link>
          </Button>
        </div>
      </div>
    </AuthSingleColumn>
  );
}
