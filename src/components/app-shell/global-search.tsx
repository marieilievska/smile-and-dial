"use client";

import {
  Bot,
  Building2,
  CornerDownLeft,
  FolderOpen,
  Loader2,
  Megaphone,
  Search,
} from "lucide-react";
import { Fragment } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { Input } from "@/components/ui/input";
import { navItems } from "@/lib/nav";

import {
  fetchGlobalSuggestions,
  type GlobalSuggestions,
  type SearchHit,
} from "./search-suggestions-action";

/** Section header label + icon per entity kind. */
const KIND_META: Record<
  SearchHit["kind"],
  { label: string; icon: typeof Building2 }
> = {
  lead: { label: "Leads", icon: Building2 },
  campaign: { label: "Campaigns", icon: Megaphone },
  agent: { label: "Agents", icon: Bot },
  list: { label: "Lists", icon: FolderOpen },
};

/** Top-bar search with a live typeahead dropdown. Three kinds of result:
 *   1. Entity hits — leads, campaigns, agents, and lists matching the query
 *      (debounced 200ms, RLS-scoped on the server), grouped by kind.
 *   2. Jump-to-page — matching nav destinations (gated to what the user can
 *      reach), shown as a final "Go to" section.
 *  Arrow keys cycle every row; Enter opens the highlighted one, else falls back
 *  to the full /leads?q=… search.
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
  const [suggestions, setSuggestions] = useState<GlobalSuggestions | null>(
    null,
  );
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
  const pageMatches = useMemo(
    () =>
      query.length >= 1
        ? accessiblePages
            .filter((p) => p.label.toLowerCase().includes(query))
            .slice(0, 4)
        : [],
    [accessiblePages, query],
  );

  // Entity hits flattened in display order — the index into this array is the
  // highlight index (pages continue the count after it).
  const entityHits = useMemo(
    () =>
      suggestions
        ? [
            ...suggestions.leads,
            ...suggestions.campaigns,
            ...suggestions.agents,
            ...suggestions.lists,
          ]
        : [],
    [suggestions],
  );
  // Every navigable row's href, in render order (entities, then pages).
  const navHrefs = useMemo(
    () => [...entityHits.map((h) => h.href), ...pageMatches.map((p) => p.href)],
    [entityHits, pageMatches],
  );

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
      setSuggestions(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      startTransition(async () => {
        const result = await fetchGlobalSuggestions(next);
        setSuggestions(result);
        setHighlight(0);
      });
    }, 200);
  }

  function onChange(next: string) {
    setValue(next);
    setOpen(next.trim().length >= 1);
    fetchAfterDebounce(next);
  }

  /** Navigate to a result / page. Clearing the input is left to the
   *  leave-list-page effect so the URL↔input sync stays correct. */
  function go(href: string) {
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
      if (navHrefs.length > 0) {
        setOpen(true);
        setHighlight((h) => Math.min(h + 1, navHrefs.length - 1));
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && navHrefs[highlight]) {
        go(navHrefs[highlight]);
      } else {
        submitFull();
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  const searched = value.trim().length >= 2;
  const showDropdown =
    open && (entityHits.length > 0 || pageMatches.length > 0 || searched);

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
        placeholder="Search leads, campaigns, agents… or jump to a page"
        aria-label="Search or jump to a page"
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
          className="border-border bg-popover absolute top-full right-0 left-0 z-50 mt-1.5 max-h-[440px] overflow-y-auto rounded-lg border shadow-lg"
        >
          {/* Entity hits — grouped; a header renders when the kind changes. */}
          {entityHits.length > 0 ? (
            <ul className="flex flex-col py-1">
              {entityHits.map((hit, i) => {
                const prev = entityHits[i - 1];
                const showHeader = !prev || prev.kind !== hit.kind;
                const Meta = KIND_META[hit.kind];
                return (
                  <Fragment key={`${hit.kind}-${hit.id}`}>
                    {showHeader ? (
                      <li
                        aria-hidden
                        className="text-muted-foreground px-3 pt-2 pb-1 text-[10px] font-semibold tracking-[0.14em] uppercase"
                      >
                        {Meta.label}
                      </li>
                    ) : null}
                    <li>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === highlight}
                        onMouseEnter={() => setHighlight(i)}
                        onClick={() => go(hit.href)}
                        className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                          i === highlight ? "bg-muted" : "hover:bg-muted/60"
                        }`}
                      >
                        <Meta.icon className="text-muted-foreground size-4 shrink-0" />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="text-foreground truncate text-sm font-medium">
                            {hit.label}
                          </span>
                          {hit.sublabel ? (
                            <span className="text-muted-foreground truncate text-xs">
                              {hit.sublabel}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  </Fragment>
                );
              })}
            </ul>
          ) : null}

          {/* Jump-to-page — the final "Go to" section. */}
          {pageMatches.length > 0 ? (
            <div className="border-border border-t py-1">
              <p className="text-muted-foreground px-3 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.14em] uppercase">
                Go to
              </p>
              <ul className="flex flex-col">
                {pageMatches.map((p, i) => {
                  const gi = entityHits.length + i;
                  return (
                    <li key={p.href}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={gi === highlight}
                        onMouseEnter={() => setHighlight(gi)}
                        onClick={() => go(p.href)}
                        className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                          gi === highlight ? "bg-muted" : "hover:bg-muted/60"
                        }`}
                      >
                        <p.icon className="text-muted-foreground size-4 shrink-0" />
                        <span className="text-foreground text-sm">
                          Go to {p.label}
                        </span>
                        <CornerDownLeft className="text-muted-foreground/60 ml-auto size-3.5 shrink-0" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {/* Full-search escape hatch / empty state. */}
          {searched ? (
            entityHits.length > 0 || pageMatches.length > 0 ? (
              <div className="border-border bg-muted/30 border-t px-3 py-2 text-xs">
                <button
                  type="button"
                  onClick={submitFull}
                  className="text-foreground inline-flex items-center gap-1.5 font-medium underline-offset-2 hover:underline"
                >
                  See all leads for &ldquo;{value}&rdquo; →
                </button>
              </div>
            ) : !pending ? (
              <p className="text-muted-foreground px-3 py-3 text-sm">
                No matches.
              </p>
            ) : null
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
