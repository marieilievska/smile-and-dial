"use client";

import { RouteError } from "@/components/app-shell/route-error";

/** Reporting was one of the slowest routes measured in the 2026-09-06 audit (4.7s), which makes it one of the likelier ones to fail under load. */
export default function ReportingError({
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
      surface="Reporting"
      hint="The report didn't finish building. Try again — if it keeps failing, a narrower window usually gets through."
    />
  );
}
