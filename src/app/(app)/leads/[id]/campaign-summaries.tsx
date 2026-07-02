"use client";

import { useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  clearLeadCampaignSummary,
  updateLeadCampaignSummary,
} from "@/lib/leads/lead-actions";

export type CampaignSummary = {
  campaignId: string;
  campaignName: string;
  summary: string;
};

/** Per-campaign rolling summaries — the memory each campaign's next call sees.
 *  Admins can edit or clear one (clear = fresh start next call). */
export function CampaignSummaries({
  leadId,
  summaries,
  isAdmin,
}: {
  leadId: string;
  summaries: CampaignSummary[];
  isAdmin: boolean;
}) {
  if (summaries.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No campaign summaries yet — they build up as this lead is called.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {summaries.map((s) => (
        <SummaryCard
          key={s.campaignId}
          leadId={leadId}
          summary={s}
          isAdmin={isAdmin}
        />
      ))}
    </div>
  );
}

function SummaryCard({
  leadId,
  summary,
  isAdmin,
}: {
  leadId: string;
  summary: CampaignSummary;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary.summary);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await updateLeadCampaignSummary({
        leadId,
        campaignId: summary.campaignId,
        summary: draft,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Summary updated.");
      setEditing(false);
      router.refresh();
    });
  }

  function clear() {
    if (!confirm("Clear this campaign's summary? The next call starts fresh."))
      return;
    startTransition(async () => {
      const res = await clearLeadCampaignSummary({
        leadId,
        campaignId: summary.campaignId,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Summary cleared.");
      router.refresh();
    });
  }

  return (
    <div className="border-border/60 rounded-lg border p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-foreground text-xs font-semibold">
          {summary.campaignName}
        </span>
        {isAdmin && !editing ? (
          <div className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              disabled={pending}
              aria-label="Edit summary"
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clear}
              disabled={pending}
              aria-label="Clear summary"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={save} disabled={pending}>
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(summary.summary);
                setEditing(false);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-foreground text-sm whitespace-pre-line">
          {summary.summary || "—"}
        </p>
      )}
    </div>
  );
}
