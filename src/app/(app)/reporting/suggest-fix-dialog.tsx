"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { generatePromptSuggestion } from "@/lib/review/actions";
import type { SuggestOption } from "@/lib/review/suggestions-data";

/** Per-bucket "Suggest prompt fix": pick the agent (preselected when only one
 *  has approved examples) and draft ONE anchored edit from those examples.
 *  Nothing touches the agent here — the draft lands in "Prompt improvements"
 *  for review. */
export function SuggestFixDialog({
  bucketKey,
  bucketLabel,
  options,
}: {
  bucketKey: string;
  bucketLabel: string;
  options: SuggestOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState(
    options.length === 1 ? options[0].agentId : "",
  );
  const [pending, start] = useTransition();
  const total = options.reduce((n, o) => n + o.available, 0);
  if (total === 0) return null;

  function generate() {
    start(async () => {
      const r = await generatePromptSuggestion({ flagKey: bucketKey, agentId });
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success(
        "Suggestion drafted — review it under Prompt improvements.",
      );
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          title={`Draft a prompt fix from ${total} approved example${total === 1 ? "" : "s"}`}
        >
          <Sparkles className="size-3.5" />
          Suggest prompt fix ({total})
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Draft a prompt fix</DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">
          The AI reads the agent&apos;s live prompt plus your approved &ldquo;
          {bucketLabel}&rdquo; examples and drafts one targeted edit. Nothing
          changes until you approve it.
        </p>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Which agent&apos;s prompt to fix</legend>
          {options.map((o) => (
            <label
              key={o.agentId}
              className="border-border hover:bg-muted/40 flex cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`suggest-agent-${bucketKey}`}
                  checked={agentId === o.agentId}
                  onChange={() => setAgentId(o.agentId)}
                />
                {o.agentName}
              </span>
              <span className="text-muted-foreground text-xs">
                {o.available} example{o.available === 1 ? "" : "s"}
              </span>
            </label>
          ))}
        </fieldset>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={generate} disabled={pending || !agentId}>
            {pending ? "Drafting…" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
