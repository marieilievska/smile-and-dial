"use client";

import { BookOpen, FileText, Pencil, Plus } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  createKnowledgeBase,
  updateKnowledgeBase,
} from "@/lib/knowledge-bases/actions";

import { DialogSection } from "../dialog-section";

export type KbData = {
  id: string;
  name: string;
  description: string | null;
};

/** Create/edit dialog for /settings/knowledge-bases. Round 24 —
 *  Section pattern + placeholder examples + a hint about the next
 *  step (adding sources) on the create flow.
 *
 *  Note: we intentionally don't fold the Sources step into this
 *  dialog. Sources need file uploads and URL crawls — too much for
 *  a fly-in create modal. We just surface the "next step" hint so
 *  the user knows where to go after creating. */
export function KbFormDialog({
  mode,
  kb,
  triggerLabel,
}: {
  mode: "create" | "edit";
  kb?: KbData;
  triggerLabel?: string;
}) {
  const isEdit = mode === "edit";
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(kb?.name ?? "");
  const [description, setDescription] = useState(kb?.description ?? "");

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const result =
          isEdit && kb
            ? await updateKnowledgeBase(kb.id, name, description)
            : await createKnowledgeBase(name, description);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success(
            isEdit
              ? "Knowledge base updated."
              : "Knowledge base created. Add some sources to make it useful.",
          );
          setOpen(false);
          if (!isEdit) {
            setName("");
            setDescription("");
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
            aria-label={`Edit ${kb?.name ?? "knowledge base"}`}
          >
            <Pencil className="size-4" />
            Edit
          </Button>
        ) : (
          <Button>
            <Plus className="size-4" />
            {triggerLabel ?? "New knowledge base"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit knowledge base" : "New knowledge base"}
          </DialogTitle>
          <DialogDescription>
            A knowledge base is reference material — files and URLs — an AI
            agent can draw on during calls.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogSection
            icon={<BookOpen className="size-3.5" />}
            title="Name"
            description="Shown to agents during the build wizard when picking which knowledge to attach."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kb-name">Name</Label>
              <Input
                id="kb-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Pricing FAQ, Onboarding playbook"
                required
              />
            </div>
          </DialogSection>

          <DialogSection
            icon={<FileText className="size-3.5" />}
            title="Description"
            description="Optional. Helps you remember what's in here when picking it later."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kb-description">Description</Label>
              <Textarea
                id="kb-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                placeholder="e.g. Common objections + answers from the sales playbook"
              />
            </div>
          </DialogSection>

          {!isEdit ? (
            <p className="text-muted-foreground border-border bg-muted/30 ml-7 rounded-md border px-3 py-2 text-xs">
              After you create the base, open it from the list and add files or
              URLs as sources.
            </p>
          ) : null}

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
              {pending
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Create knowledge base"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
