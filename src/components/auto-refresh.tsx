"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/client";

/**
 * Keeps a page's server-rendered data fresh without a manual reload, using
 * two mechanisms:
 *
 *  1. Realtime push (`realtime`) — subscribes to changes on the `calls` table
 *     and soft-refreshes the instant a call row moves, so outcomes and the
 *     live "on call" pulse land immediately. This is the fast path.
 *  2. A polling fallback — a soft `router.refresh()` on an interval, as a
 *     safety net for any push that never arrives (dropped socket, RLS, the
 *     table not being in the realtime publication). Faster while something is
 *     active (`active`), slower when idle.
 *
 * `router.refresh()` is a SOFT refresh: it re-runs the server query and swaps
 * fresh rows in without a full reload, preserving scroll, filters, and open
 * client state.
 *
 * Both mechanisms share the same guards:
 *  - Skip when the tab is backgrounded (don't refresh a screen no one sees).
 *  - Skip while a dialog / popover / dropdown / select is OPEN — a background
 *    re-render mid-interaction makes overlays feel janky, so we hold off until
 *    it closes.
 *
 * NOTE: this is mounted per-page on the live surfaces only (Today, Leads, Lead
 * detail, Calls) — NOT app-wide. A blanket app-wide poll re-ran the entire
 * server tree on every page and was the dominant driver of Vercel function
 * invocations + transfer.
 */
export function AutoRefresh({
  active = false,
  activeMs = 10000,
  idleMs = 60000,
  realtime = false,
}: {
  active?: boolean;
  activeMs?: number;
  idleMs?: number;
  realtime?: boolean;
}) {
  const router = useRouter();
  const intervalMs = active ? activeMs : idleMs;

  // Shared guard: only soft-refresh when the tab is visible and nothing is
  // open on top of the page. `router` from useRouter is stable, so this is
  // stable too — both effects below can depend on it without re-arming.
  const refreshIfSafe = useCallback(() => {
    if (typeof document === "undefined" || document.hidden) return;
    const overlayOpen = document.querySelector(
      '[role="dialog"][data-state="open"], [data-radix-popper-content-wrapper], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
    );
    if (overlayOpen) return;
    router.refresh();
  }, [router]);

  // Polling fallback (safety net). Fast while `active`, slow when idle.
  useEffect(() => {
    const id = setInterval(refreshIfSafe, intervalMs);
    return () => clearInterval(id);
  }, [refreshIfSafe, intervalMs]);

  // Realtime push. Subscribes to every change on `calls`; a burst of dialer
  // inserts is debounced into a single refresh. Realtime honours RLS, so each
  // user only receives events for calls they can already see. If the channel
  // can't authorize or the table isn't published, this is silently inert and
  // the polling fallback above still covers us.
  useEffect(() => {
    if (!realtime) return;
    const supabase = createClient();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const channel = supabase
      .channel("auto-refresh:calls")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "calls" },
        () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(refreshIfSafe, 800);
        },
      )
      .subscribe();
    return () => {
      if (debounce) clearTimeout(debounce);
      void supabase.removeChannel(channel);
    };
  }, [realtime, refreshIfSafe]);

  return null;
}
