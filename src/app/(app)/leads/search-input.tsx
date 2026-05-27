"use client";

import { Loader2, Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Input } from "@/components/ui/input";

/** Debounced URL-bound search for /leads. Replaces the form+button
 *  pattern with on-type filtering at 300ms. Uses router.replace so the
 *  back button isn't littered with intermediate keystrokes.
 *
 *  Renders a small spinner during the transition so the user sees that
 *  something is happening between keystroke and table refresh. */
export function LeadsSearchInput() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlValue = searchParams.get("q") ?? "";
  const [value, setValue] = useState(urlValue);
  const [pending, startTransition] = useTransition();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // If the URL `q` changes from outside (e.g. user clicks a saved
  // view) we need to mirror that in the input. Track the last URL
  // value we synced from; if it changes, reset to it. This is the
  // "derived state with a reset trigger" pattern that avoids putting
  // a setState in an effect.
  const [lastUrlValue, setLastUrlValue] = useState(urlValue);
  if (urlValue !== lastUrlValue) {
    setLastUrlValue(urlValue);
    setValue(urlValue);
  }

  function commit(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.trim()) params.set("q", next.trim());
    else params.delete("q");
    params.delete("page");
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/leads?${qs}` : "/leads");
    });
  }

  function onChange(next: string) {
    setValue(next);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => commit(next), 300);
  }

  function clear() {
    setValue("");
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    commit("");
  }

  return (
    <div className="relative max-w-sm flex-1">
      <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
      <Input
        type="search"
        name="q"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search company, phone, or email"
        className="pr-9 pl-9"
        aria-label="Search leads"
      />
      <div className="absolute top-1/2 right-2 -translate-y-1/2">
        {pending ? (
          <Loader2 className="text-muted-foreground size-4 animate-spin" />
        ) : value ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={clear}
            className="text-muted-foreground hover:text-foreground inline-flex size-6 items-center justify-center rounded-md transition-colors"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
