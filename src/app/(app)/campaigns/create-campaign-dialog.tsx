"use client";

import { Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { createCampaign } from "@/lib/campaigns/actions";
import { setCampaignLists } from "@/lib/campaigns/list-attachments-actions";

type Option = { id: string; name: string };

/** Minimal 2-step campaign creation dialog.
 *
 *  Step 1: Name + Agent + Goal. (The three required fields.)
 *  Step 2: Optional list attachments.
 *  Submit → createCampaign + setCampaignLists.
 *
 *  Telephony, tools, knowledge base, and caps all live on the edit dialog
 *  after creation — keeping create lean is the entire point of this
 *  component. The campaign starts active with safe defaults (09:00–21:00
 *  calling hours, 30/hour cap, 300/day cap, 2 concurrent). */
export function CreateCampaignDialog({
  agents,
  goals,
  eligibleLists,
}: {
  agents: Option[];
  goals: Option[];
  eligibleLists: Option[];
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [goalId, setGoalId] = useState(goals[0]?.id ?? "");
  const [selectedListIds, setSelectedListIds] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  function reset() {
    setStep(1);
    setName("");
    setAgentId(agents[0]?.id ?? "");
    setGoalId(goals[0]?.id ?? "");
    setSelectedListIds([]);
  }

  function toggleList(id: string) {
    setSelectedListIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
  }

  function goToStep2() {
    if (!name.trim()) {
      toast.error("Give the campaign a name.");
      return;
    }
    if (!agentId) {
      toast.error("Pick an agent.");
      return;
    }
    if (!goalId) {
      toast.error("Pick a goal.");
      return;
    }
    setStep(2);
  }

  function submit() {
    startTransition(async () => {
      // Step 1 already validated name/agent/goal.
      const result = await createCampaign({
        name,
        description: "",
        agentId,
        goalId,
        twilioNumberId: "",
        // Defaults from the existing dialog — keep them aligned.
        callingHoursStart: "09:00",
        callingHoursEnd: "21:00",
        callsPerHourCap: "30",
        callsPerDayCap: "300",
        concurrencyCapPerUser: "2",
        transferDestinationPhone: "",
        dailySpendCap: "",
        monthlySpendCap: "",
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      if (result.campaignId && selectedListIds.length > 0) {
        const listResult = await setCampaignLists({
          campaignId: result.campaignId,
          listIds: selectedListIds,
        });
        if (listResult.error) {
          toast.error(listResult.error);
          return;
        }
      }
      toast.success("Campaign created.");
      setOpen(false);
      reset();
    });
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          New campaign
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {step === 1 ? "New campaign" : "Attach lists (optional)"}
          </DialogTitle>
          <DialogDescription>
            {step === 1
              ? "Pick an agent, set a goal, and give it a name. You can configure telephony, caps, and tools after it's created."
              : "Which lists should this campaign dial from? You can skip this and attach lists later."}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="create-campaign-name">Name</Label>
              <Input
                id="create-campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q1 Outbound"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="create-campaign-agent">Agent</Label>
              {agents.length > 0 ? (
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger id="create-campaign-agent">
                    <SelectValue placeholder="Choose an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No agents yet. Build one in Settings → Agents first.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="create-campaign-goal">Goal</Label>
              {goals.length > 0 ? (
                <Select value={goalId} onValueChange={setGoalId}>
                  <SelectTrigger id="create-campaign-goal">
                    <SelectValue placeholder="Choose a goal" />
                  </SelectTrigger>
                  <SelectContent>
                    {goals.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No goals yet. Create one in Goals first.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {eligibleLists.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No lists available. You can attach lists from the
                campaign&apos;s Lists tab after creating.
              </p>
            ) : (
              <div className="border-border max-h-64 overflow-y-auto rounded-md border">
                <ul className="divide-border divide-y">
                  {eligibleLists.map((l) => {
                    const checked = selectedListIds.includes(l.id);
                    return (
                      <li
                        key={l.id}
                        className="flex items-center gap-3 px-3 py-2"
                      >
                        <Checkbox
                          id={`create-list-${l.id}`}
                          checked={checked}
                          onCheckedChange={() => toggleList(l.id)}
                        />
                        <Label
                          htmlFor={`create-list-${l.id}`}
                          className="flex-1 cursor-pointer text-sm font-normal"
                        >
                          {l.name}
                        </Label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex flex-row justify-between sm:justify-between">
          <div>
            {step === 2 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep(1)}
                disabled={pending}
              >
                Back
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            {step === 1 ? (
              <Button
                type="button"
                onClick={goToStep2}
                disabled={pending || agents.length === 0 || goals.length === 0}
              >
                Continue
              </Button>
            ) : (
              <Button type="button" onClick={submit} disabled={pending}>
                {pending ? "Creating…" : "Create campaign"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
