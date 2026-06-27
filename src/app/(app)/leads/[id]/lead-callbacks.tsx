"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deleteCallbacks } from "@/lib/callbacks/actions";
import { exactDateTime, relativeTimeSigned } from "@/lib/relative-time";

export type LeadCallbackRow = {
  id: string;
  scheduledAt: string | null;
  status: string;
};

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  pending: "default",
  completed: "secondary",
  missed: "destructive",
  cancelled: "outline",
};

/** The lead's callbacks, newest first. Admins can permanently delete one
 *  (reuses deleteCallbacks, which re-syncs the lead's next-call timing). */
export function LeadCallbacks({
  callbacks,
  isAdmin,
}: {
  callbacks: LeadCallbackRow[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const visible = callbacks.filter((c) => !removed.has(c.id));

  function remove(id: string) {
    if (!window.confirm("Delete this callback? This can't be undone.")) return;
    setRemoved((s) => new Set(s).add(id)); // optimistic
    startTransition(async () => {
      const res = await deleteCallbacks([id]);
      if (res.error) {
        toast.error(res.error);
        setRemoved((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
        return;
      }
      toast.success("Callback deleted");
      router.refresh();
    });
  }

  if (visible.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No callbacks scheduled.</p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {visible.map((c) => (
        <li
          key={c.id}
          className="border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span
              className="text-foreground font-medium"
              title={exactDateTime(c.scheduledAt)}
            >
              {relativeTimeSigned(c.scheduledAt)}
            </span>
            <Badge variant={STATUS_VARIANT[c.status] ?? "outline"}>
              {c.status}
            </Badge>
          </div>
          {isAdmin ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(c.id)}
              aria-label="Delete callback"
              className="text-muted-foreground hover:text-destructive size-8"
            >
              <Trash2 className="size-4" />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
