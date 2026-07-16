"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Undo2, Wand2, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  applyPromptSuggestion,
  dismissPromptSuggestion,
  revertPromptSuggestion,
} from "@/lib/review/actions";
import type { PromptSuggestionView } from "@/lib/review/suggestions-data";

const STATUS_LABEL: Record<PromptSuggestionView["status"], string> = {
  proposed: "Awaiting your review",
  applied: "Applied",
  dismissed: "Dismissed",
  reverted: "Reverted",
};

/** "Prompt improvements": AI-drafted anchored edits built from findings Marija
 *  approved. Shows the exact old→new diff (new text editable), applies only on
 *  explicit approval, and keeps a revert path on applied changes. */
export function PromptSuggestionsPanel({
  suggestions,
}: {
  suggestions: PromptSuggestionView[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Wand2 className="text-muted-foreground size-5" />
        <h2 className="text-foreground text-base font-semibold">
          Prompt improvements
        </h2>
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">
        AI-drafted prompt fixes built only from findings you approved. Review
        the exact change (reword it if you like) — nothing reaches the agent
        until you approve it, and every applied change can be reverted.
      </p>
      {suggestions.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No suggestions yet. Confirm findings with &ldquo;Looks right&rdquo; in
          a call&apos;s review panel, then use &ldquo;Suggest prompt fix&rdquo;
          on a bucket above.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {suggestions.map((s) => (
            <SuggestionCard key={s.id} suggestion={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function SuggestionCard({
  suggestion: s,
}: {
  suggestion: PromptSuggestionView;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [texts, setTexts] = useState(() => s.edits.map((e) => e.text));
  const proposed = s.status === "proposed";

  function run(action: () => Promise<{ error: string | null }>, done: string) {
    start(async () => {
      const r = await action();
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success(done);
      router.refresh();
    });
  }

  return (
    <div className="border-border bg-card flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground text-sm font-semibold">
          {s.bucketLabel}
        </span>
        <span className="text-muted-foreground text-xs">· {s.agentName}</span>
        <span className="text-muted-foreground text-xs">
          · {new Date(s.createdAt).toLocaleDateString()}
        </span>
        <Badge
          variant={proposed ? "default" : "secondary"}
          className={proposed ? "" : "opacity-80"}
        >
          {STATUS_LABEL[s.status]}
        </Badge>
      </div>

      <p className="text-foreground text-sm">{s.rationale}</p>

      <div className="flex flex-col gap-3">
        {s.edits.map((e, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            {e.type === "replace" ? (
              <>
                <p className="text-muted-foreground text-xs font-medium">
                  Replace this part:
                </p>
                <pre className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs whitespace-pre-wrap text-red-900">
                  {e.anchor}
                </pre>
                <p className="text-muted-foreground text-xs font-medium">
                  With:
                </p>
              </>
            ) : e.type === "insert_after" ? (
              <>
                <p className="text-muted-foreground text-xs font-medium">
                  Right after this part:
                </p>
                <pre className="border-border bg-muted/30 text-muted-foreground rounded-lg border px-3 py-2 text-xs whitespace-pre-wrap">
                  {e.anchor}
                </pre>
                <p className="text-muted-foreground text-xs font-medium">
                  Add:
                </p>
              </>
            ) : (
              <p className="text-muted-foreground text-xs font-medium">
                Add at the very end of the prompt:
              </p>
            )}
            {proposed ? (
              <Textarea
                rows={3}
                value={texts[i]}
                onChange={(ev) =>
                  setTexts(texts.map((t, j) => (j === i ? ev.target.value : t)))
                }
                className="border-emerald-200 bg-emerald-50/60 text-sm"
              />
            ) : (
              <pre className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs whitespace-pre-wrap text-emerald-900">
                {e.text}
              </pre>
            )}
          </div>
        ))}
      </div>

      <p className="text-muted-foreground text-xs">
        Based on {s.exampleCount} approved example
        {s.exampleCount === 1 ? "" : "s"}
        {s.callIds.length > 0 ? (
          <>
            {": "}
            {s.callIds.map((id, i) => (
              <span key={id}>
                {i > 0 ? ", " : ""}
                <Link
                  href={`/calls?call=${id}`}
                  className="hover:text-primary underline underline-offset-2"
                >
                  call {i + 1}
                </Link>
              </span>
            ))}
          </>
        ) : null}
        .
      </p>

      {proposed ? (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  applyPromptSuggestion({
                    suggestionId: s.id,
                    editedTexts: texts,
                  }),
                "Applied to the agent.",
              )
            }
          >
            <Check className="size-3.5" />
            {pending ? "Working…" : "Approve & apply"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              run(
                () => dismissPromptSuggestion({ suggestionId: s.id }),
                "Dismissed — those examples are available again.",
              )
            }
          >
            <X className="size-3.5" />
            Dismiss
          </Button>
        </div>
      ) : s.status === "applied" ? (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">
            Applied{" "}
            {s.appliedAt ? new Date(s.appliedAt).toLocaleDateString() : ""} —
            logged in the Agent Prompt Log.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(
                () => revertPromptSuggestion({ suggestionId: s.id }),
                "Previous prompt restored.",
              )
            }
          >
            <Undo2 className="size-3.5" />
            {pending ? "Working…" : "Revert"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
