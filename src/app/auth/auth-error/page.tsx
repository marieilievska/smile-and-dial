import { MailX } from "lucide-react";
import Link from "next/link";

import { AuthSingleColumn } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";

export default function AuthErrorPage() {
  return (
    <AuthSingleColumn>
      <div
        className="animate-in fade-in zoom-in-95 flex flex-col items-center gap-6 rounded-2xl border border-white/10 bg-white/[0.04] p-10 text-center backdrop-blur-2xl duration-500"
        style={{ boxShadow: "0 24px 70px -30px rgba(0,0,0,0.65)" }}
      >
        <div className="flex size-14 items-center justify-center rounded-full bg-amber-500/15 text-amber-300">
          <MailX className="size-7" />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            That link has expired.
          </h1>
          <p className="text-sm leading-relaxed text-white/60">
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
