"use client";

import { RouteError } from "@/components/app-shell/route-error";

/** One bad lead should not blank the app. This keeps the failure on the lead and offers a way back to the list. */
export default function LeadDetailError({
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
      surface="this lead"
      hint="We couldn't load this lead's details. Try again, or go back to the leads list."
      backHref="/leads"
      backLabel="Back to leads"
    />
  );
}
