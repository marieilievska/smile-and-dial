"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { upsertDashboardNote } from "@/lib/agent-analytics/actions";

/** Inline, autosaving note for one dashboard day (why the numbers moved). Saves
 *  on blur / Enter; admin-only path (the server action re-checks). */
export function DashboardNoteCell({
  day,
  initial,
}: {
  day: string;
  initial: string;
}) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [pending, start] = useTransition();

  function commit() {
    if (value.trim() === saved.trim()) return;
    start(async () => {
      const res = await upsertDashboardNote({ day, note: value });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setSaved(value);
      toast.success("Note saved");
    });
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      placeholder="Add a note…"
      disabled={pending}
      aria-label={`Note for ${day}`}
      className="border-border bg-background focus:border-primary w-full min-w-[180px] rounded-md border px-2 py-1 text-xs outline-none disabled:opacity-50"
    />
  );
}
