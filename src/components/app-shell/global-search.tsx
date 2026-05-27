"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";

/** Top-bar search that targets the Leads page from anywhere in the app.
 *  Submitting (Enter) navigates to /leads?q=… so the user always lands
 *  on the searchable surface even if they're starting from /today or
 *  /settings.
 *
 *  On /leads itself we keep the input in sync with the URL `?q=` so
 *  the value mirrors saved-view / chip / direct-URL state. */
export function GlobalSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onLeadsPage = pathname?.startsWith("/leads");
  const urlQ = onLeadsPage ? (searchParams.get("q") ?? "") : "";
  const [value, setValue] = useState(urlQ);

  // When the URL `q` changes externally (saved view click, filter chip
  // removed, etc.) sync the visible value to it. Render-only check
  // avoids the setState-in-effect lint trap.
  const [lastUrlQ, setLastUrlQ] = useState(urlQ);
  if (onLeadsPage && urlQ !== lastUrlQ) {
    setLastUrlQ(urlQ);
    setValue(urlQ);
  }

  // If the user navigates off /leads, clear the sticky search term so
  // the box doesn't keep showing a query that no longer applies.
  useEffect(() => {
    if (!onLeadsPage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValue("");
    }
  }, [onLeadsPage]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = value.trim();
    if (onLeadsPage) {
      const params = new URLSearchParams(searchParams.toString());
      if (next) params.set("q", next);
      else params.delete("q");
      params.delete("page");
      const qs = params.toString();
      router.replace(qs ? `/leads?${qs}` : "/leads");
    } else {
      router.push(next ? `/leads?q=${encodeURIComponent(next)}` : "/leads");
    }
  }

  return (
    <form
      role="search"
      onSubmit={submit}
      className="relative w-full max-w-md"
      data-testid="global-search"
    >
      <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
      <Input
        type="search"
        name="q"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search leads — company, phone, or email"
        aria-label="Search leads"
        className="h-9 pl-9"
      />
    </form>
  );
}
