"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { deleteSmartList } from "@/lib/smart-lists/actions";

export function SmartListPicker({
  lists,
  activeRecipeJson,
}: {
  lists: { id: string; name: string; filter: unknown }[];
  activeRecipeJson: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, start] = useTransition();

  const active = lists.find(
    (l) => JSON.stringify(l.filter) === activeRecipeJson,
  );

  function load(id: string) {
    const l = lists.find((x) => x.id === id);
    if (!l) return;
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("recipe", JSON.stringify(l.filter));
    sp.delete("page");
    router.push(`/leads?${sp.toString()}`);
  }

  function remove() {
    if (!active) return;
    start(async () => {
      const res = await deleteSmartList({ id: active.id });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Smart list deleted.");
    });
  }

  if (lists.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <Select value={active?.id ?? ""} onValueChange={load}>
        <SelectTrigger className="h-8 w-[15rem]">
          <SelectValue placeholder="Load a smart list…" />
        </SelectTrigger>
        <SelectContent>
          {lists.map((l) => (
            <SelectItem key={l.id} value={l.id}>
              {l.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={remove}
        >
          Delete
        </Button>
      ) : null}
    </div>
  );
}
