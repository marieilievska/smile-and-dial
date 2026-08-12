"use client";

import { GitMerge } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listMergeTargets, mergeCampaign } from "@/lib/campaigns/actions";

/**
 * "End & merge into…" — folds this (source) campaign's whole footprint into
 * another campaign the user owns, then ends the source. Moves leads, list
 * attachments, callbacks, per-campaign summaries, and phone numbers; call
 * history stays with the source so its past reporting is untouched.
 *
 * The reusable capability lives in mergeCampaign() / the merge_campaign()
 * Postgres function — this dialog is just the picker + the plain-English
 * warning of what moves.
 */
export function MergeCampaignDialog({
  campaign,
}: {
  campaign: { id: string; name: string };
}) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<
    { id: string; name: string; status: string }[] | null
  >(null);
  const [targetId, setTargetId] = useState<string>("");
  const [pending, startTransition] = useTransition();

  function stop(event: React.SyntheticEvent) {
    event.stopPropagation();
  }

  // Load the user's other campaigns the first time the dialog opens.
  useEffect(() => {
    if (!open || targets !== null) return;
    let cancelled = false;
    listMergeTargets(campaign.id)
      .then((rows) => {
        if (!cancelled) setTargets(rows);
      })
      .catch(() => {
        if (!cancelled) setTargets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, targets, campaign.id]);

  function onMerge() {
    if (!targetId) return;
    startTransition(async () => {
      try {
        const result = await mergeCampaign({
          sourceId: campaign.id,
          targetId,
        });
        if (result.error) {
          toast.error(result.error);
          return;
        }
        const into = targets?.find((t) => t.id === targetId)?.name ?? "target";
        toast.success(`Merged into “${into}”.`);
        setOpen(false);
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Merge ${campaign.name} into another campaign`}
          className="h-7 px-2"
          onClick={stop}
        >
          <GitMerge className="size-3.5" />
          Merge
        </Button>
      </DialogTrigger>
      <DialogContent onClick={stop}>
        <DialogHeader>
          <DialogTitle>Merge &ldquo;{campaign.name}&rdquo; into…</DialogTitle>
          <DialogDescription>
            Everything in this campaign moves to the one you pick — its leads
            (with their summaries and callbacks), its attached lists, and its
            phone numbers. Then this campaign ends. Its call history stays here,
            so past reports don&rsquo;t change. This can&rsquo;t be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <Select
            value={targetId}
            onValueChange={setTargetId}
            disabled={pending || targets === null || targets.length === 0}
          >
            <SelectTrigger aria-label="Campaign to merge into">
              <SelectValue
                placeholder={
                  targets === null
                    ? "Loading campaigns…"
                    : targets.length === 0
                      ? "No other campaign to merge into"
                      : "Choose a campaign"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {(targets ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                  {t.status !== "active" ? ` (${t.status})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={onMerge} disabled={pending || !targetId}>
            {pending ? "Merging…" : "Merge & end campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
