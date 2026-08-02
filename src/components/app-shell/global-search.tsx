"use client";

import { CornerDownLeft, Loader2, Phone, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { Input } from "@/components/ui/input";
import { formatPhone } from "@/lib/format-phone";
import { navItems } from "@/lib/nav";

import {
  fetchLeadSuggestions,
  type LeadSuggestion,
} from "./search-suggestions-action";

/** Top-bar search with a live typeahead dropdown. Two kinds of result:
 *   1. Jump-to-page — matching nav destinations (gated to what the user can
 *      reach), so the prominent box is a real "find anything" affordance and
 *      not a leads-only input that looks global.
 *   2. Leads — up to 8 matching leads fetched (debounced 200ms) from the
 *      server; picking one jumps to /leads/<id>.
 *  Pressing Enter picks the highlighted lead, else the first page match, else
 *  falls back to the full /leads?q=… search.
 *
 *  Works from any page. On /leads and /calls the input value is kept in sync
 *  with the URL `?q=` so saved-view clicks / chip removals mirror it. */
export function GlobalSearch({
  isAdmin,
  userEmail,
}: {
  isAdmin: boolean;
  userEmail: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onLeadsPage = pathname?.startsWith("/leads") ?? false;
  const onCallsPage = pathname?.startsWith("/calls") ?? false;
  const onListPage = onLeadsPage || onCallsPage;
  const urlQ = onListPage ? (searchParams.get("q") ?? "") : "";

  const [value, setValue] = useState(urlQ);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LeadSuggestion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [pending, startTransition] = useTransition();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isMac, setIsMac] = useState(false);

  // Nav destinations this user can actually reach — the jump-to-page pool.
  const accessiblePages = useMemo(
    () =>
      navItems.filter(
        (item) =>
          (!item.adminOnly || isAdmin) &&
          (!item.restrictToEmail || item.restrictToEmail === userEmail),
      ),
    [isAdmin, userEmail],
  );

  const query = value.trim().toLowerCase();
  const pageMatches =
    query.length >= 1
      ? accessiblePages
          .filter((p) => p.label.toLowerCase().includes(query))
          .slice(0, 4)
      : [];

  // Mirror URL→input when the URL `q` changes externally.
  const [lastUrlQ, setLastUrlQ] = useState(urlQ);
  if (onListPage && urlQ !== lastUrlQ) {
    setLastUrlQ(urlQ);
    setValue(urlQ);
  }

  // Clear when leaving a list page.
  useEffect(() => {
    if (!onListPage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValue("");
    }
  }, [onListPage]);

  // Close the dropdown on outside click.
  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // ⌘K (Mac) / Ctrl+K (Win/Linux) focuses the search from anywhere.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMac(/mac/i.test(navigator.userAgent));
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function fetchAfterDebounce(next: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (next.trim().length < 2) {
      setItems([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      startTransition(async () => {
        const result = await fetchLeadSuggestions(next);
        setItems(result.items);
        setHighlight(0);
      });
    }, 200);
  }

  function onChange(next: string) {
    setValue(next);
    setOpen(next.trim().length >= 1);
    fetchAfterDebounce(next);
  }

  function gotoLead(id: string) {
    setOpen(false);
    router.push(`/leads/${id}`);
  }

  function gotoPage(href: string) {
    setOpen(false);
    if (!onListPage) setValue("");
    router.push(href);
  }

  function submitFull() {
    setOpen(false);
    const next = value.trim();
    if (onListPage) {
      const basePath = onCallsPage ? "/calls" : "/leads";
      const params = new URLSearchParams(searchParams.toString());
      if (next) params.set("q", next);
      else params.delete("q");
      params.delete("page");
      const qs = params.toString();
      router.replace(qs ? `${basePath}?${qs}` : basePath);
    } else {
      router.push(next ? `/leads?q=${encodeURIComponent(next)}` : "/leads");
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (items.length > 0) {
        setOpen(true);
        setHighlight((h) => Math.min(h + 1, items.length - 1));
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && items[highlight]) {
        gotoLead(items[highlight].id);
      } else if (pageMatches.length > 0) {
        gotoPage(pageMatches[0].href);
      } else {
        submitFull();
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  const searchedLeads = value.trim().length >= 2;
  const showDropdown =
    open && (pageMatches.length > 0 || items.length > 0 || searchedLeads);

  return (
    <div
      ref={wrapRef}
      role="search"
      data-testid="global-search"
      className="relative w-full max-w-md"
    >
      <Search className="text-muted-foreground absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2" />
      <Input
        ref={inputRef}
        type="search"
        name="q"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          if (value.trim().length >= 1) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        placeholder="Search leads, or jump to a page"
        aria-label="Search leads or jump to a page"
        aria-autocomplete="list"
        aria-expanded={showDropdown}
        aria-controls="global-search-listbox"
        className="bg-muted/40 h-9 rounded-xl pr-16 pl-9"
        autoComplete="off"
      />
      {pending ? (
        <Loader2 className="text-muted-foreground absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin" />
      ) : !value ? (
        <kbd
          aria-hidden
          className="border-border text-muted-foreground bg-background pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium sm:inline-block"
        >
          {isMac ? "⌘K" : "Ctrl K"}
        </kbd>
      ) : null}

      {showDropdown ? (
        <div
          id="global-search-listbox"
          role="listbox"
          data-testid="global-search-dropdown"
          className="border-border bg-popover absolute top-full right-0 left-0 z-50 mt-1.5 max-h-[420px] overflow-y-auto rounded-lg border shadow-lg"
        >
          {pageMatches.length > 0 ? (
            <div className="border-border border-b py-1 last:border-b-0">
              <p className="text-muted-foreground px-3 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.14em] uppercase">
                Pages
              </p>
              <ul className="flex flex-col">
                {pageMatches.map((p) => (
                  <li key={p.href}>
                    <button
                      type="button"
                      onClick={() => gotoPage(p.href)}
                      className="hover:bg-muted/60 flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors"
                    >
                      <p.icon className="text-muted-foreground size-4 shrink-0" />
                      <span className="text-foreground text-sm">
                        Go to {p.label}
                      </span>
                      <CornerDownLeft className="text-muted-foreground/60 ml-auto size-3.5 shrink-0" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {items.length > 0 ? (
            <>
              {pageMatches.length > 0 ? (
                <p className="text-muted-foreground px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[0.14em] uppercase">
                  Leads
                </p>
              ) : null}
              <ul className="flex flex-col py-1">
                {items.map((item, i) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === highlight}
                      onMouseEnter={() => setHighlight(i)}
                      onClick={() => gotoLead(item.id)}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                        i === highlight ? "bg-muted" : "hover:bg-muted/60"
                      }`}
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="text-foreground truncate text-sm font-medium">
                          {item.company || "Untitled lead"}
                        </span>
                        <span className="text-muted-foreground flex items-center gap-2 truncate text-xs">
                          {item.phone ? (
                            <span className="inline-flex items-center gap-1 font-mono">
                              <Phone className="size-3" />
                              {formatPhone(item.phone)}
                            </span>
                          ) : null}
                          {item.city || item.state ? (
                            <span>
                              {[item.city, item.state]
                                .filter(Boolean)
                                .join(", ")}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="border-border bg-muted/30 border-t px-3 py-2 text-xs">
                <button
                  type="button"
                  onClick={submitFull}
                  className="text-foreground inline-flex items-center gap-1.5 font-medium underline-offset-2 hover:underline"
                >
                  See all results for &ldquo;{value}&rdquo; →
                </button>
              </div>
            </>
          ) : searchedLeads && !pending ? (
            <p className="text-muted-foreground px-3 py-3 text-sm">
              No matching leads.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
