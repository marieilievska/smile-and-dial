"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/** In-app error boundary — catches render errors in any /(app) route and
 *  shows a branded, theme-aware fallback inside the shell (sidebar + top bar
 *  stay put) instead of the stark platform default. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="border-border bg-card flex max-w-md flex-col items-center gap-4 rounded-2xl border p-8 text-center shadow-sm">
        <span className="bg-destructive/10 text-destructive flex size-12 items-center justify-center rounded-2xl">
          <AlertTriangle className="size-6" />
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-foreground text-lg font-semibold">
            Something went wrong
          </h1>
          <p className="text-muted-foreground text-sm">
            This page hit an unexpected error. Try again — if it keeps
            happening, it&apos;s on us, not you.
          </p>
          {error.digest ? (
            <p className="text-muted-foreground/70 font-mono text-[11px]">
              Ref: {error.digest}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={reset}>
            <RotateCw className="size-4" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <Link href="/today">Back to dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
