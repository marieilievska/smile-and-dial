"use client";

import {
  Check,
  ListChecks,
  Megaphone,
  Plus,
  Sparkles,
  Target,
  User,
} from "lucide-react";
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

/** Two-step campaign creation dialog (round 15 redesign).
 *
 *  Step 1: Name + Agent + Goal — the three required fields.
 *  Step 2: Optional list attachments.
 *  Submit → createCampaign + setCampaignLists.
 *
 *  Telephony, tools, knowledge base, and caps live on the edit
 *  drawer. The dialog ships the campaign with safe defaults
 *  (09:00–21:00 calling, 30 calls/hr, 2 concurrent) and lets the
 *  user refine those after creation.
 *
 *  Visual treatment:
 *  - Step indicator pill at the top so the user knows there's a
 *    second step and roughly where they are.
 *  - Coral Sparkles icon next to the title to match the rest of the
 *    app's accent moments.
 *  - A small "what we'll set up by default" note on step 1 so the
 *    user understands what they're NOT picking right now.
 *  - Step 2 list picker keeps a tidy bordered list with a hover
 *    background. Selecting a list is one click — checkbox follows. */
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
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [goalId, setGoalId] = useState(goals[0]?.id ?? "");
  const [selectedListIds, setSelectedListIds] = useState<string[]>([]);

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
      const result = await createCampaign({
        name,
        description: "",
        agentId,
        goalId,
        twilioNumberId: "",
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          {/* Round 15 — step indicator pill so the user knows there's
              a second step. Coral Sparkles to match the rest of the
              app's accent moments. */}
          <div className="text-muted-foreground mb-1 inline-flex items-center gap-2 text-[10px] font-medium tracking-[0.16em] uppercase">
            <Sparkles className="size-3.5" style={{ color: "var(--coral)" }} />
            <span>Step {step} of 2</span>
            <StepDots current={step} />
          </div>
          <DialogTitle className="text-xl">
            {step === 1 ? "New campaign" : "Attach lists (optional)"}
          </DialogTitle>
          <DialogDescription>
            {step === 1
              ? "Pick an agent, set a goal, and give it a name. Telephony, caps, and tools can be tuned after creation."
              : "Lists attached here get dialed when the campaign runs. You can skip and attach later from the campaign settings."}
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <div className="flex flex-col gap-5 py-1">
            <FieldRow
              icon={<Megaphone className="size-4" />}
              label="Name"
              htmlFor="create-campaign-name"
              hint="Short, scannable — appears in the leads table and on reports."
            >
              <Input
                id="create-campaign-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q1 Outbound"
                required
              />
            </FieldRow>

            <FieldRow
              icon={<User className="size-4" />}
              label="Agent"
              htmlFor="create-campaign-agent"
              hint="The AI personality + prompt that dials. Build new ones under Settings → Agents."
            >
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
                <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-sm">
                  No agents yet. Build one in Settings → Agents first.
                </p>
              )}
            </FieldRow>

            <FieldRow
              icon={<Target className="size-4" />}
              label="Goal"
              htmlFor="create-campaign-goal"
              hint="What the AI is trying to achieve on each call."
            >
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
                <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-sm">
                  No goals yet. Create one in Settings → Goals.
                </p>
              )}
            </FieldRow>

            {/* "What we'll set up by default" — pre-empts the
                'wait what about hours / caps?' question. */}
            <div className="border-border bg-muted/30 rounded-md border px-3 py-2 text-xs">
              <p className="text-muted-foreground">
                <span className="text-foreground font-medium">
                  Safe defaults applied:
                </span>{" "}
                9am – 9pm calling · 30 calls/hour · 300/day · 2 concurrent. Edit
                any of these later from the campaign settings.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 py-1">
            {eligibleLists.length === 0 ? (
              <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
                <ListChecks className="text-muted-foreground size-6" />
                <p className="text-foreground text-sm font-medium">
                  No lists available right now
                </p>
                <p className="text-muted-foreground max-w-sm text-xs">
                  Each list can be attached to one active campaign at a time.
                  Create or detach a list, then come back. You can also attach
                  lists later from the campaign settings.
                </p>
              </div>
            ) : (
              <>
                <p className="text-muted-foreground text-xs">
                  {selectedListIds.length === 0
                    ? "Pick the lists this campaign should dial. You can skip and add them later."
                    : `${selectedListIds.length} list${
                        selectedListIds.length === 1 ? "" : "s"
                      } selected.`}
                </p>
                <div className="border-border max-h-64 overflow-y-auto rounded-md border">
                  <ul className="divide-border divide-y">
                    {eligibleLists.map((l) => {
                      const checked = selectedListIds.includes(l.id);
                      return (
                        <li key={l.id}>
                          <label
                            htmlFor={`create-list-${l.id}`}
                            className={`hover:bg-muted/40 flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors ${
                              checked ? "bg-[color:var(--coral)]/5" : ""
                            }`}
                          >
                            <Checkbox
                              id={`create-list-${l.id}`}
                              checked={checked}
                              onCheckedChange={() => toggleList(l.id)}
                            />
                            <span className="flex-1 text-sm font-normal">
                              {l.name}
                            </span>
                            {checked ? (
                              <Check className="size-4 text-[color:var(--coral)]" />
                            ) : null}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </>
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
                className="bg-[color:var(--coral)] text-white hover:bg-[color:var(--coral)]/90"
              >
                Continue
              </Button>
            ) : (
              <Button
                type="button"
                onClick={submit}
                disabled={pending}
                className="bg-[color:var(--coral)] text-white hover:bg-[color:var(--coral)]/90"
              >
                {pending ? "Creating…" : "Create campaign"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Three-dot progress indicator next to the step label. The current
 *  step's dot is coral; previous steps are filled muted; remaining
 *  steps are an empty outline. */
function StepDots({ current }: { current: 1 | 2 }) {
  return (
    <span className="inline-flex items-center gap-1">
      {[1, 2].map((s) => (
        <span
          key={s}
          aria-hidden
          className={`size-1.5 rounded-full ${
            s === current
              ? "bg-[color:var(--coral)]"
              : s < current
                ? "bg-muted-foreground"
                : "border-muted-foreground/40 border"
          }`}
        />
      ))}
    </span>
  );
}

/** Reusable label + hint + control row. Lets every field on step 1
 *  share the same icon + uppercase letter-spaced label treatment
 *  as the rest of the app. */
function FieldRow({
  icon,
  label,
  htmlFor,
  hint,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label
        htmlFor={htmlFor}
        className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.16em] uppercase"
      >
        <span className="text-[color:var(--coral)]">{icon}</span>
        {label}
      </Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}
