"use client";

import { useState } from "react";
import { Filter, Plus, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { leadStatusLabel } from "@/lib/labels";
import { LEAD_TIMEZONES } from "@/lib/leads/timezone";

const STATUSES = [
  "ready_to_call",
  "callback",
  "resting",
  "goal_met",
  "attended",
  "no_show",
  "closed",
  "sale",
  "dnc",
  "email_replied",
];

const FILTER_KEYS = [
  "list",
  "status",
  "timezone",
  "created_from",
  "created_to",
  "lastcall_from",
  "lastcall_to",
  "nextcall_from",
  "nextcall_to",
];

export type CustomField = {
  id: string;
  name: string;
  slug: string;
  options: string[];
  /** Enum-like field (few collected values) → value dropdown. Otherwise the
   *  filter is presence-only ("lead has a value for this field"). */
  isEnum: boolean;
};

/** One editable custom-field filter row. `value` is a single collected value,
 *  or ANY_VALUE = "any value (just present)". Rows with the same field OR. */
type CustomRow = { key: number; slug: string; value: string };

/** Radix <Select> can't use an empty string as a value, so these sentinels
 *  stand in for "no field picked" / "any value". */
const PICK_FIELD = "__pick__";
const ANY_VALUE = "__any__";

/** Seed editable rows from the cf_/cfp_ URL params. */
function seedCustomRows(searchParams: URLSearchParams): CustomRow[] {
  const rows: CustomRow[] = [];
  let key = 0;
  for (const [k, v] of searchParams.entries()) {
    if (!v) continue;
    if (k.startsWith("cfp_")) {
      rows.push({ key: key++, slug: k.slice(4), value: ANY_VALUE });
    } else if (k.startsWith("cf_")) {
      const slug = k.slice(3);
      for (const val of v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        rows.push({ key: key++, slug, value: val });
      }
    }
  }
  return rows;
}

export function LeadsFilters({
  lists,
  customFields,
}: {
  lists: { id: string; name: string }[];
  customFields: CustomField[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  const fieldBySlug = new Map(customFields.map((f) => [f.slug, f]));

  const get = (key: string) => searchParams.get(key) ?? "";
  const [list, setList] = useState(get("list") || "any");
  const [status, setStatus] = useState(get("status") || "any");
  const [timezone, setTimezone] = useState(get("timezone") || "any");
  const [createdFrom, setCreatedFrom] = useState(get("created_from"));
  const [createdTo, setCreatedTo] = useState(get("created_to"));
  const [lastFrom, setLastFrom] = useState(get("lastcall_from"));
  const [lastTo, setLastTo] = useState(get("lastcall_to"));
  const [nextFrom, setNextFrom] = useState(get("nextcall_from"));
  const [nextTo, setNextTo] = useState(get("nextcall_to"));
  const [customRows, setCustomRows] = useState<CustomRow[]>(() =>
    seedCustomRows(new URLSearchParams(searchParams.toString())),
  );
  const [rowKeySeq, setRowKeySeq] = useState(1000);

  // Resync the draft fields whenever the URL filters change from OUTSIDE the
  // popover (removing a chip, a stat-strip tile, a saved view). Same "derived
  // state with a reset trigger" pattern the other filters use.
  const paramsKey = searchParams.toString();
  const [lastParamsKey, setLastParamsKey] = useState(paramsKey);
  if (paramsKey !== lastParamsKey) {
    setLastParamsKey(paramsKey);
    setList(get("list") || "any");
    setStatus(get("status") || "any");
    setTimezone(get("timezone") || "any");
    setCreatedFrom(get("created_from"));
    setCreatedTo(get("created_to"));
    setLastFrom(get("lastcall_from"));
    setLastTo(get("lastcall_to"));
    setNextFrom(get("nextcall_from"));
    setNextTo(get("nextcall_to"));
    setCustomRows(seedCustomRows(new URLSearchParams(paramsKey)));
  }

  // Active count = base filters present + distinct custom fields filtered.
  const customSlugs = new Set<string>();
  for (const k of searchParams.keys()) {
    if (k.startsWith("cfp_")) customSlugs.add(k.slice(4));
    else if (k.startsWith("cf_")) customSlugs.add(k.slice(3));
  }
  const activeCount =
    FILTER_KEYS.filter((key) => searchParams.get(key)).length +
    customSlugs.size;

  function updateRow(key: number, patch: Partial<CustomRow>) {
    setCustomRows((rows) =>
      rows.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
  }
  function removeRow(key: number) {
    setCustomRows((rows) => rows.filter((r) => r.key !== key));
  }
  function addRow() {
    setCustomRows((rows) => [
      ...rows,
      { key: rowKeySeq, slug: "", value: ANY_VALUE },
    ]);
    setRowKeySeq((n) => n + 1);
  }

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    const set = (key: string, value: string) => {
      if (value && value !== "any") params.set(key, value);
      else params.delete(key);
    };
    set("list", list);
    set("status", status);
    set("timezone", timezone);
    set("created_from", createdFrom);
    set("created_to", createdTo);
    set("lastcall_from", lastFrom);
    set("lastcall_to", lastTo);
    set("nextcall_from", nextFrom);
    set("nextcall_to", nextTo);

    // Re-encode custom-field filters from the rows. An enum field with a
    // specific value → cf_<slug> (values comma-joined = OR). Any other case
    // (a free-text field, or an enum field left on "Any value") → cfp_<slug>=1,
    // i.e. "the lead has a value for this field".
    for (const k of [...params.keys()]) {
      if (k.startsWith("cf_") || k.startsWith("cfp_")) params.delete(k);
    }
    const valsBySlug = new Map<string, string[]>();
    const presentSlugs = new Set<string>();
    for (const r of customRows) {
      if (!r.slug) continue;
      const field = fieldBySlug.get(r.slug);
      if (field?.isEnum && r.value && r.value !== ANY_VALUE) {
        const arr = valsBySlug.get(r.slug) ?? [];
        if (!arr.includes(r.value)) arr.push(r.value);
        valsBySlug.set(r.slug, arr);
      } else {
        presentSlugs.add(r.slug);
      }
    }
    for (const [slug, vals] of valsBySlug) {
      if (vals.length) params.set(`cf_${slug}`, vals.join(","));
    }
    for (const slug of presentSlugs) {
      // A specific value already implies presence; don't also emit cfp_.
      if (!valsBySlug.has(slug)) params.set(`cfp_${slug}`, "1");
    }

    params.delete("page");
    router.push(`/leads?${params.toString()}`);
    setOpen(false);
  }

  function clear() {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of [...FILTER_KEYS, "page"]) params.delete(key);
    for (const k of [...params.keys()]) {
      if (k.startsWith("cf_") || k.startsWith("cfp_")) params.delete(k);
    }
    setList("any");
    setStatus("any");
    setTimezone("any");
    setCreatedFrom("");
    setCreatedTo("");
    setLastFrom("");
    setLastTo("");
    setNextFrom("");
    setNextTo("");
    setCustomRows([]);
    router.push(`/leads?${params.toString()}`);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <Filter className="size-4" />
          Filters
          {activeCount > 0 ? (
            <Badge variant="secondary">{activeCount}</Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[80vh] w-96 overflow-y-auto"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="filter-list">List</Label>
            <Select value={list} onValueChange={setList}>
              <SelectTrigger id="filter-list">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any list</SelectItem>
                {lists.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="filter-status">Stage</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="filter-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any stage</SelectItem>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {leadStatusLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="filter-timezone">Time zone</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="filter-timezone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any time zone</SelectItem>
                {LEAD_TIMEZONES.map((tz) => (
                  <SelectItem key={tz.value} value={tz.value}>
                    {tz.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DateRange
            label="Created"
            from={createdFrom}
            to={createdTo}
            onFrom={setCreatedFrom}
            onTo={setCreatedTo}
          />
          <DateRange
            label="Last call"
            from={lastFrom}
            to={lastTo}
            onFrom={setLastFrom}
            onTo={setLastTo}
          />
          <DateRange
            label="Next call"
            from={nextFrom}
            to={nextTo}
            onFrom={setNextFrom}
            onTo={setNextTo}
          />

          {customFields.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label>Custom fields</Label>
              {customRows.map((row) => {
                const field = fieldBySlug.get(row.slug);
                return (
                  <div
                    key={row.key}
                    className="border-border flex flex-col gap-1.5 rounded-md border p-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <Select
                        value={row.slug || PICK_FIELD}
                        onValueChange={(v) =>
                          updateRow(row.key, {
                            slug: v === PICK_FIELD ? "" : v,
                            value: ANY_VALUE,
                          })
                        }
                      >
                        <SelectTrigger className="h-8 flex-1">
                          <SelectValue placeholder="Pick a field" />
                        </SelectTrigger>
                        <SelectContent>
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.slug}>
                              {f.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label="Remove filter"
                        onClick={() => removeRow(row.key)}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                    {row.slug && field?.isEnum ? (
                      <Select
                        value={row.value}
                        onValueChange={(v) => updateRow(row.key, { value: v })}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={ANY_VALUE}>
                            Any value (just present)
                          </SelectItem>
                          {(field?.options ?? []).map((o) => (
                            <SelectItem key={o} value={o}>
                              {o}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : row.slug ? (
                      <p className="text-muted-foreground px-0.5 text-xs">
                        Leads that have a value for this field.
                      </p>
                    ) : null}
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={addRow}
              >
                <Plus className="size-3.5" />
                Add field filter
              </Button>
            </div>
          ) : null}

          <div className="flex justify-between gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
            <Button size="sm" onClick={apply}>
              Apply filters
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DateRange({
  label,
  from,
  to,
  onFrom,
  onTo,
}: {
  label: string;
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="date"
          aria-label={`${label} from`}
          value={from}
          onChange={(e) => onFrom(e.target.value)}
        />
        <span className="text-muted-foreground text-sm">to</span>
        <Input
          type="date"
          aria-label={`${label} to`}
          value={to}
          onChange={(e) => onTo(e.target.value)}
        />
      </div>
    </div>
  );
}
