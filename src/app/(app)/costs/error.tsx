"use client";

import { RouteError } from "@/components/app-shell/route-error";

/** Costs reads the spend rollup for the window; same timeout shape as Analytics. */
export default function CostsError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <RouteError
      error={error}
      retry={unstable_retry}
      surface="Costs"
      hint="This usually means the date range was too wide to add up in time. Try again, or pick a shorter range."
    />
  );
}
