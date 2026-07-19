"use client";

import { ListChecks, MapPin, Plus, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { stateForAreaCode } from "@/lib/dialer/nanp-states";
import type { AreaCodePlan } from "@/lib/dialer/pool-plan";
import { addNumbersToPool, suggestPoolPlan } from "@/lib/twilio/pool-actions";

import { DialogSection } from "../dialog-section";

/** Mirrors the server-side cap in pool-actions.ts — a fat-fingered count can't
 *  drain the Twilio account, and the UI shouldn't let you type past it either. */
const MAX_BATCH = 25;

/** "Buy into pool" — a campaign-targeted buy, distinct from the plain
 *  BuyNumberDialog (which buys an unattached number). Numbers bought here land
 *  straight in a campaign's pool: purchased at Twilio, imported to ElevenLabs,
 *  and the campaign's agent assigned for inbound — all server-side in
 *  addNumbersToPool. The "Suggest a plan" step reads the campaign's lead
 *  geography (suggestPoolPlan) so the operator buys local presence where it
 *  actually helps connect rates, not just wherever. */
export function BuyIntoPoolDialog({
  campaigns,
}: {
  campaigns: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [campaignId, setCampaignId] = useState("");
  const [areaCode, setAreaCode] = useState("");
  const [count, setCount] = useState("5");
  const [plan, setPlan] = useState<AreaCodePlan[] | null>(null);
  const [totalLeads, setTotalLeads] = useState(0);
  const [planning, startPlanning] = useTransition();
  const [buying, startBuying] = useTransition();
  const [result, setResult] = useState<{
    bought: number;
    failed: number;
  } | null>(null);

  const areaCodeValid = /^\d{3}$/.test(areaCode);
  const countNum = Math.max(
    1,
    Math.min(MAX_BATCH, Math.floor(Number(count) || 0)),
  );

  function suggest() {
    if (!campaignId) return;
    startPlanning(async () => {
      setPlan(null);
      const res = await suggestPoolPlan(campaignId);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setTotalLeads(res.totalLeads);
      setPlan(res.plan);
    });
  }

  // Named to avoid the "use..." hook-naming convention (react-hooks/rules-of-hooks
  // flags it otherwise) — this is a plain event handler, not a hook.
  function applySuggestion(row: AreaCodePlan) {
    setAreaCode(row.areaCode);
    setCount(String(Math.max(1, Math.min(MAX_BATCH, row.suggested || 1))));
  }

  function buy() {
    if (!campaignId || !areaCodeValid) return;
    startBuying(async () => {
      setResult(null);
      const res = await addNumbersToPool({
        campaignId,
        areaCode,
        count: countNum,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setResult({ bought: res.bought, failed: res.failed });
      if (res.bought > 0) {
        toast.success(
          res.failed > 0
            ? `Bought ${res.bought}, failed ${res.failed}.`
            : `Bought ${res.bought} number${res.bought === 1 ? "" : "s"}.`,
        );
        // Give the operator a beat to read the result line before the dialog
        // closes itself; the table has already revalidated server-side.
        setTimeout(() => setOpen(false), 1200);
      } else {
        toast.error(`Bought 0, failed ${res.failed}.`);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setPlan(null);
          setResult(null);
          setAreaCode("");
          setCount("5");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus className="size-4" />
          Buy into pool
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Buy numbers into a campaign&apos;s pool</DialogTitle>
          <DialogDescription>
            Buys local numbers into this campaign&apos;s pool — imported to
            ElevenLabs and assigned for inbound automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <DialogSection
            icon={<ListChecks className="size-3.5" />}
            title="Campaign"
            description="Which campaign's pool to buy into."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pool-campaign">Campaign</Label>
              <Select value={campaignId} onValueChange={setCampaignId}>
                <SelectTrigger id="pool-campaign" className="w-full">
                  <SelectValue placeholder="Choose a campaign" />
                </SelectTrigger>
                <SelectContent>
                  {campaigns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </DialogSection>

          <DialogSection
            icon={<Sparkles className="size-3.5" />}
            title="Suggest a plan"
            description="Based on this campaign's lead geography vs. what it already owns."
          >
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={suggest}
                disabled={!campaignId || planning}
                className="self-start"
              >
                {planning ? "Thinking…" : "Suggest a plan"}
              </Button>
              {plan !== null ? (
                plan.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-muted-foreground text-xs">
                      {totalLeads} lead{totalLeads === 1 ? "" : "s"} with a
                      phone number across {plan.length} area code
                      {plan.length === 1 ? "" : "s"}.
                    </p>
                    <ul className="flex flex-col gap-1">
                      {plan.slice(0, 8).map((row) => (
                        <li
                          key={row.areaCode}
                          className="border-border flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
                        >
                          <span className="text-foreground">
                            {row.areaCode} ·{" "}
                            {stateForAreaCode(row.areaCode) ?? "—"} —{" "}
                            {row.leads} lead{row.leads === 1 ? "" : "s"}, own{" "}
                            {row.owned}
                            {row.suggested > 0
                              ? `, buy ${row.suggested} more`
                              : ", covered"}
                          </span>
                          {row.suggested > 0 ? (
                            <button
                              type="button"
                              className="text-primary shrink-0 font-medium hover:underline"
                              onClick={() => applySuggestion(row)}
                            >
                              Use
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Attach a list with leads to this campaign first.
                  </p>
                )
              ) : null}
            </div>
          </DialogSection>

          <DialogSection
            icon={<MapPin className="size-3.5" />}
            title="Area code + count"
            description={`3-digit area code and how many to buy. Max ${MAX_BATCH} per batch.`}
          >
            <div className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="pool-area-code">Area code</Label>
                <Input
                  id="pool-area-code"
                  value={areaCode}
                  maxLength={3}
                  placeholder="e.g. 954"
                  onChange={(event) =>
                    setAreaCode(
                      event.target.value.replace(/\D/g, "").slice(0, 3),
                    )
                  }
                />
              </div>
              <div className="flex w-24 flex-col gap-1.5">
                <Label htmlFor="pool-count">Count</Label>
                <Input
                  id="pool-count"
                  type="number"
                  min={1}
                  max={MAX_BATCH}
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                />
              </div>
            </div>
          </DialogSection>

          {result ? (
            <p
              className={
                result.failed > 0
                  ? "text-warning text-sm"
                  : "text-muted-foreground text-sm"
              }
            >
              Bought {result.bought}, failed {result.failed}.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={buy}
            disabled={!campaignId || !areaCodeValid || buying}
          >
            {buying ? "Buying…" : `Buy ${countNum}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
