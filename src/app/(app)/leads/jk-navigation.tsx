"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Round 33 (I2) — vim-style row navigation for the leads table.
 *  j moves the focus to the next row, k to the previous, Enter
 *  opens it. Ignores the key if the user is typing in an input,
 *  textarea, or contenteditable, so global search and the URL
 *  search box are unaffected.
 *
 *  No visible chrome — the existing `tabIndex={0}` on LeadRow gives
 *  the row a real focus ring, so j/k just moves DOM focus. That
 *  also means screen readers track the focus change naturally. */
export function LeadsJKNavigation({ ids }: { ids: string[] }) {
  const router = useRouter();

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return true;
      }
      if (target.isContentEditable) return true;
      // shadcn Popover / dropdown content can host inputs further
      // down — bail if any ancestor is an editable surface.
      return target.closest('[contenteditable="true"]') != null;
    }

    function focusRow(id: string) {
      const row = document.querySelector<HTMLTableRowElement>(
        `tr[data-lead-id="${id}"]`,
      );
      if (row) {
        row.focus();
        row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }

    function currentIndex(): number {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return -1;
      const id = active.dataset.leadId;
      if (!id) return -1;
      return ids.indexOf(id);
    }

    function onKey(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;
      // Modifier keys would conflict with browser shortcuts.
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === "j") {
        const idx = currentIndex();
        const next = idx < 0 ? 0 : Math.min(idx + 1, ids.length - 1);
        if (ids[next]) {
          event.preventDefault();
          focusRow(ids[next]);
        }
      } else if (event.key === "k") {
        const idx = currentIndex();
        const next = idx < 0 ? 0 : Math.max(idx - 1, 0);
        if (ids[next]) {
          event.preventDefault();
          focusRow(ids[next]);
        }
      } else if (event.key === "Enter") {
        const idx = currentIndex();
        if (idx >= 0 && ids[idx]) {
          event.preventDefault();
          router.push(`/leads/${ids[idx]}`);
        }
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ids, router]);

  return null;
}
