"use client";

import { Columns3 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { DEFAULT_COLUMN_KEYS, LEAD_COLUMNS } from "./columns";

export function ColumnPicker() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const colsParam = searchParams.get("cols");
  const visible = new Set(
    colsParam ? colsParam.split(",") : DEFAULT_COLUMN_KEYS,
  );

  function toggle(key: string) {
    const next = new Set(visible);
    if (next.has(key)) {
      if (next.size === 1) return; // keep at least one column
      next.delete(key);
    } else {
      next.add(key);
    }
    const ordered = LEAD_COLUMNS.filter((c) => next.has(c.key)).map(
      (c) => c.key,
    );
    const params = new URLSearchParams(searchParams.toString());
    const matchesDefault =
      ordered.length === DEFAULT_COLUMN_KEYS.length &&
      DEFAULT_COLUMN_KEYS.every((k) => next.has(k));
    if (matchesDefault) params.delete("cols");
    else params.set("cols", ordered.join(","));
    router.replace(`/leads?${params.toString()}`);
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <Columns3 className="size-4" />
          Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56">
        <div className="flex flex-col gap-2.5">
          {LEAD_COLUMNS.map((col) => (
            <div key={col.key} className="flex items-center gap-2">
              <Checkbox
                id={`col-${col.key}`}
                checked={visible.has(col.key)}
                onCheckedChange={() => toggle(col.key)}
              />
              <Label htmlFor={`col-${col.key}`} className="font-normal">
                {col.label}
              </Label>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
