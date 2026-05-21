import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function AuthErrorPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="border-border bg-card w-full max-w-sm rounded-lg border p-8 text-center shadow-sm">
        <h1 className="text-foreground text-xl font-bold tracking-tight">
          This link is no longer valid
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Your invitation or password-reset link has expired or has already been
          used. Ask an admin to send a new one.
        </p>
        <Button asChild className="mt-6">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    </main>
  );
}
