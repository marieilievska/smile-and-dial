"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * Shared error UI for every route-level boundary.
 *
 * One component so a failure on Costs and a failure on Leads look and behave
 * identically, while each boundary can still name the surface that broke.
 *
 * On `retry` vs `reset` — Next passes BOTH to an error.tsx. `reset()` clears
 * the error state and re-renders the boundary's children WITHOUT re-fetching;
 * `unstable_retry()` re-fetches and re-renders. Almost every failure in this
 * app is a server-side data fetch (a slow rollup, a timed-out query), and for
 * those `reset()` re-runs straight back into the same failure — a "Try again"
 * button that cannot succeed. Boundaries pass `unstable_retry` here.
 */
export function RouteError({
  error,
  retry,
  /** What broke, in the user's words — "Analytics", "your settings". Shown in
   *  the message so the page names itself instead of saying "this page". */
  surface,
  /** Optional extra line for a surface with a known likely cause. */
  hint,
  /** Where the escape-hatch button goes. Defaults to the dashboard; a
   *  boundary deep in a section should point at that section's list instead,
   *  so the button agrees with what the message just suggested. */
  backHref = "/today",
  backLabel = "Back to dashboard",
}: {
  error: Error & { digest?: string };
  retry: () => void;
  surface?: string;
  hint?: string;
  backHref?: string;
  backLabel?: string;
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
            {surface ? `Couldn't load ${surface}` : "Something went wrong"}
          </h1>
          <p className="text-muted-foreground text-sm">
            {hint ??
              "This page hit an unexpected error. Try again — if it keeps happening, it's on us, not you."}
          </p>
          {error.digest ? (
            <p className="text-muted-foreground/70 font-mono text-[11px]">
              Ref: {error.digest}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => retry()}>
            <RotateCw className="size-4" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <Link href={backHref}>{backLabel}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
