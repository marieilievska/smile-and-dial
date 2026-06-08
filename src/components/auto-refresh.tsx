"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Quietly re-fetches the current page on an interval (router.refresh — a SOFT
 * refresh that re-runs the server query and swaps fresh rows in without a full
 * reload, preserving scroll, filters, and open client state). Used so call
 * outcomes, statuses, and the live "on call" pulse update on their own.
 *
 * Behavior:
 *  - Polls faster while something is active (`active`), slower when idle.
 *  - Pauses when the tab is backgrounded (don't refresh a screen no one sees).
 *  - Pauses while a dialog / popover / dropdown / select is OPEN — a background
 *    re-render mid-interaction makes overlays feel janky, so we hold off until
 *    it closes. This keeps modals and popups snappy.
 */
export function AutoRefresh({
  active = false,
  activeMs = 5000,
  idleMs = 15000,
}: {
  active?: boolean;
  activeMs?: number;
  idleMs?: number;
}) {
  const router = useRouter();
  const intervalMs = active ? activeMs : idleMs;

  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.hidden) return;
      // Any open Radix overlay (dialog, popover, dropdown/context menu, select)
      // — skip this tick so we don't re-render underneath an open UI.
      const overlayOpen = document.querySelector(
        '[role="dialog"][data-state="open"], [data-radix-popper-content-wrapper], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
      );
      if (overlayOpen) return;
      router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
