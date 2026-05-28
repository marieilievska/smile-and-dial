"use client";

import { Loader2, Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Input } from "@/components/ui/input";

/** Debounced URL-bound search for /settings/users. Matches the leads
 *  and DNC search inputs — commits at 300ms via router.replace so the
 *  back-button history isn't littered with keystrokes. */
export function UsersSearchInput() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlValue = searchParams.get("q") ?? "";
  const [value, setValue] = useState(urlValue);
  const [pending, startTransition] = useTransition();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirror external URL changes (e.g. a status tab click).
  const [lastUrlValue, setLastUrlValue] = useState(urlValue);
  if (urlValue !== lastUrlValue) {
    setLastUrlValue(urlValue);
    setValue(urlValue);
  }

  function commit(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.trim()) params.set("q", next.trim());
    else params.delete("q");
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/settings/users?${qs}` : "/settings/users");
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
        placeholder="Search name or email"
        className="pr-9 pl-9"
        aria-label="Search users"
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
