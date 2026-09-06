"use client";

import { RouteError } from "@/components/app-shell/route-error";

/** Analytics aggregates a whole date window in one pass, so a wide range is the most likely thing to time out here. Say so, rather than making the user guess. */
export default function AnalyticsError({
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
      surface="Analytics"
      hint="This usually means the date range was too wide to add up in time. Try again, or pick a shorter range."
    />
  );
}
