"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Quietly re-fetches the Calls page on an interval so outcomes, statuses, and
 * the live "in progress" count update on their own — no manual refresh while
 * you watch a batch of calls land. Uses router.refresh(), a SOFT refresh: it
 * re-runs the server query and swaps in fresh rows without a full reload, so
 * scroll position, open filters, and the call-detail modal stay put.
 *
 * Polls faster while calls are in flight, slower when idle, and pauses when the
 * tab is in the background so it isn't refreshing for a screen no one's
 * looking at.
 */
export function CallsAutoRefresh({ hasActive }: { hasActive: boolean }) {
  const router = useRouter();
  const intervalMs = hasActive ? 6000 : 15000;

  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
