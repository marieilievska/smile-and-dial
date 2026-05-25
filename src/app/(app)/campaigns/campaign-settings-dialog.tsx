"use client";

import { useState, useTransition } from "react";
import { Pencil, Plus } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { createCampaign, updateCampaign } from "@/lib/campaigns/actions";

type Option = { id: string; name: string };

export type CampaignData = {
  id: string;
  name: string;
  description: string | null;
  agent_id: string;
  goal_id: string;
  daily_spend_cap: number | null;
  monthly_spend_cap: number | null;
};

export function CampaignSettingsDialog({
  mode,
  campaign,
  agents,
  goals,
}: {
  mode: "create" | "edit";
  campaign?: CampaignData;
  agents: Option[];
  goals: Option[];
}) {
  const isEdit = mode === "edit";
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(campaign?.name ?? "");
  const [description, setDescription] = useState(campaign?.description ?? "");
  const [agentId, setAgentId] = useState(
    campaign?.agent_id ?? agents[0]?.id ?? "",
  );
  const [goalId, setGoalId] = useState(campaign?.goal_id ?? goals[0]?.id ?? "");
  const [dailySpendCap, setDailySpendCap] = useState(
    campaign?.daily_spend_cap != null ? String(campaign.daily_spend_cap) : "",
  );
  const [monthlySpendCap, setMonthlySpendCap] = useState(
    campaign?.monthly_spend_cap != null
      ? String(campaign.monthly_spend_cap)
      : "",
  );

  function submit() {
    startTransition(async () => {
      const input = {
        name,
        description,
        agentId,
        goalId,
        dailySpendCap,
        monthlySpendCap,
      };
      const result =
        isEdit && campaign
          ? await updateCampaign(campaign.id, input)
          : await createCampaign(input);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(isEdit ? "Campaign updated." : "Campaign created.");
        setOpen(false);
        if (!isEdit) {
          setName("");
          setDescription("");
          setDailySpendCap("");
          setMonthlySpendCap("");
        }
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {isEdit ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${campaign?.name ?? "campaign"}`}
          >
            <Pencil className="size-4" />
            Edit
          </Button>
        ) : (
          <Button>
            <Plus className="size-4" />
            New campaign
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit campaign" : "New campaign"}</DialogTitle>
          <DialogDescription>
            A campaign ties a list of leads to an agent and a goal.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general" className="flex flex-col gap-4">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="goal">Goal</TabsTrigger>
          </TabsList>

          <TabsContent
            value="general"
            className="flex flex-col gap-4 outline-none"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-name">Name</Label>
              <Input
                id="campaign-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-description">Description</Label>
              <Textarea
                id="campaign-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="campaign-daily">Daily spend cap ($)</Label>
                <Input
                  id="campaign-daily"
                  type="number"
                  value={dailySpendCap}
                  onChange={(event) => setDailySpendCap(event.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="campaign-monthly">Monthly spend cap ($)</Label>
                <Input
                  id="campaign-monthly"
                  type="number"
                  value={monthlySpendCap}
                  onChange={(event) => setMonthlySpendCap(event.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent
            value="agent"
            className="flex flex-col gap-4 outline-none"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-agent">Agent</Label>
              {agents.length > 0 ? (
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger id="campaign-agent">
                    <SelectValue placeholder="Choose an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No agents yet. Build one in Settings → Agents.
                </p>
              )}
            </div>
          </TabsContent>

          <TabsContent
            value="goal"
            className="flex flex-col gap-4 outline-none"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="campaign-goal">Goal</Label>
              {goals.length > 0 ? (
                <Select value={goalId} onValueChange={setGoalId}>
                  <SelectTrigger id="campaign-goal">
                    <SelectValue placeholder="Choose a goal" />
                  </SelectTrigger>
                  <SelectContent>
                    {goals.map((goal) => (
                      <SelectItem key={goal.id} value={goal.id}>
                        {goal.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No goals yet. Add one on the Goals page.
                </p>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create campaign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
