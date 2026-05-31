"use client";

import { FileText, Pencil, Plus, Star, Target } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { createGoal, updateGoal } from "@/lib/goals/actions";

import { DialogSection } from "../dialog-section";

export type GoalData = {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
};

/** Create/edit dialog for /settings/goals. Round 24 — Section
 *  pattern + placeholder examples + "default" checkbox now spells
 *  out the consequence in the helper line. */
export function GoalFormDialog({
  mode,
  goal,
  triggerLabel,
}: {
  mode: "create" | "edit";
  goal?: GoalData;
  triggerLabel?: string;
}) {
  const isEdit = mode === "edit";
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(goal?.name ?? "");
  const [description, setDescription] = useState(goal?.description ?? "");
  const [isDefault, setIsDefault] = useState(goal?.is_default ?? false);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const result =
          isEdit && goal
            ? await updateGoal(goal.id, name, description, isDefault)
            : await createGoal(name, description, isDefault);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success(isEdit ? "Goal updated." : "Goal created.");
          setOpen(false);
          if (!isEdit) {
            setName("");
            setDescription("");
            setIsDefault(false);
          }
        }
      } catch {
        toast.error("Something went wrong. Please try again.");
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
            aria-label={`Edit ${goal?.name ?? "goal"}`}
          >
            <Pencil className="size-4" />
            Edit
          </Button>
        ) : (
          <Button>
            <Plus className="size-4" />
            {triggerLabel ?? "New goal"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit goal" : "New goal"}</DialogTitle>
          <DialogDescription>
            A goal is what a campaign&apos;s calls are trying to achieve. Pick
            one when you create a campaign.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogSection
            icon={<Target className="size-3.5" />}
            title="Name"
            description="Used in the campaign goal picker and in the analytics roll-ups."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="goal-name">Name</Label>
              <Input
                id="goal-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Book a 15-min consultation"
                required
              />
            </div>
          </DialogSection>

          <DialogSection
            icon={<FileText className="size-3.5" />}
            title="Description"
            description="What does success on this goal look like for the AI agent?"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="goal-description">Description</Label>
              <Textarea
                id="goal-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                placeholder="Lead agrees to a calendar invite for next week — and the invite has been sent."
              />
            </div>
          </DialogSection>

          <DialogSection
            icon={<Star className="size-3.5" />}
            title="Default"
            description="The default goal is pre-selected when an operator creates a new campaign."
          >
            <label className="text-foreground inline-flex cursor-pointer items-center gap-2 text-sm select-none">
              <Checkbox
                id="goal-default"
                checked={isDefault}
                onCheckedChange={(checked) => setIsDefault(checked === true)}
              />
              Make this the default goal
            </label>
          </DialogSection>

          <DialogFooter className="flex-row items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create goal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
