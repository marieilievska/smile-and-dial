"use client";

import { useTransition } from "react";
import { Lightbulb } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { approveCandidate, dismissCandidate } from "@/lib/review/actions";
import type { CandidateFlag } from "@/lib/review/buckets";

export function SuggestedFlagsPanel({
  candidates,
}: {
  candidates: CandidateFlag[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  if (candidates.length === 0) return null;

  function act(key: string, fn: typeof approveCandidate, okMsg: string) {
    start(async () => {
      const res = await fn({ key });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(okMsg);
      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Lightbulb className="size-5 text-indigo-600" />
        <h3 className="text-foreground text-sm font-semibold">
          New flags the AI suggests
        </h3>
        <Badge variant="secondary">{candidates.length}</Badge>
      </div>
      <p className="text-muted-foreground mb-3 text-xs">
        The reviewer spotted recurring situations the checklist doesn’t cover
        yet. Add one to the checklist, or dismiss it.
      </p>
      <div className="flex flex-col gap-2">
        {candidates.map((c) => (
          <div
            key={c.key}
            className="border-border/70 bg-card flex items-start justify-between gap-3 rounded-lg border p-3"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-foreground text-sm font-medium">
                  {c.label}
                </span>
                <Badge variant="outline">{c.lens}</Badge>
                <Badge variant="outline">sev {c.severity}</Badge>
              </div>
              {c.rationale ? (
                <p className="text-muted-foreground text-xs">{c.rationale}</p>
              ) : null}
              <p className="text-muted-foreground text-xs italic">
                Checks: {c.guidance}
              </p>
              {c.exampleCallIds.length > 0 ? (
                <p className="text-muted-foreground text-xs">
                  {c.exampleCallIds.length} example call
                  {c.exampleCallIds.length === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  act(c.key, approveCandidate, "Added to the checklist")
                }
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => act(c.key, dismissCandidate, "Dismissed")}
              >
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
