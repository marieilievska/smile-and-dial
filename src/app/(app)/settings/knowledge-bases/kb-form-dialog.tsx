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
import { Textarea } from "@/components/ui/textarea";
import {
  createKnowledgeBase,
  updateKnowledgeBase,
} from "@/lib/knowledge-bases/actions";

export type KbData = {
  id: string;
  name: string;
  description: string | null;
};

export function KbFormDialog({
  mode,
  kb,
}: {
  mode: "create" | "edit";
  kb?: KbData;
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
            isEdit ? "Knowledge base updated." : "Knowledge base created.",
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
            New knowledge base
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit knowledge base" : "New knowledge base"}
          </DialogTitle>
          <DialogDescription>
            A knowledge base is reference material an AI agent can draw on.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="kb-name">Name</Label>
            <Input
              id="kb-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="kb-description">Description</Label>
            <Textarea
              id="kb-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
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
