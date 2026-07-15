"use client";

import { FileText, MessageSquare, Pencil, Plus } from "lucide-react";
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
  createSmsTemplate,
  updateSmsTemplate,
} from "@/lib/sms-templates/actions";

import { DialogSection } from "../dialog-section";

export type SmsTemplateData = {
  id: string;
  name: string;
  body: string;
};

// "Reply STOP to opt out." — appended automatically to every send.
const OPT_OUT_SUFFIX_LEN = "\n\nReply STOP to opt out.".length;

/** Create/edit dialog for /settings/sms-templates. The send_text tool sends the
 *  campaign's chosen template verbatim (+ an auto opt-out line), filling
 *  {{variables}} from the lead. */
export function SmsTemplateFormDialog({
  mode,
  template,
  triggerLabel,
}: {
  mode: "create" | "edit";
  template?: SmsTemplateData;
  triggerLabel?: string;
}) {
  const isEdit = mode === "edit";
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(template?.name ?? "");
  const [body, setBody] = useState(template?.body ?? "");

  const totalLen = body.length + OPT_OUT_SUFFIX_LEN;
  const segments = Math.max(1, Math.ceil(totalLen / 153));

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const result =
          isEdit && template
            ? await updateSmsTemplate(template.id, name, body)
            : await createSmsTemplate(name, body);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success(isEdit ? "Template updated." : "Template created.");
          setOpen(false);
          if (!isEdit) {
            setName("");
            setBody("");
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
            aria-label={`Edit ${template?.name ?? "template"}`}
          >
            <Pencil className="size-4" />
            Edit
          </Button>
        ) : (
          <Button>
            <Plus className="size-4" />
            {triggerLabel ?? "New template"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit text template" : "New text template"}
          </DialogTitle>
          <DialogDescription>
            The exact text the AI sends when it uses the send-text tool. Attach
            it to a campaign under the campaign&apos;s Booking section.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogSection
            icon={<FileText className="size-3.5" />}
            title="Name"
            description="Internal label — shown in the campaign template picker."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sms-tmpl-name">Name</Label>
              <Input
                id="sms-tmpl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Demo follow-up text"
                required
              />
            </div>
          </DialogSection>

          <DialogSection
            icon={<MessageSquare className="size-3.5" />}
            title="Message"
            description="The text body. Insert lead details with {{variables}}."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sms-tmpl-body">Message</Label>
              <Textarea
                id="sms-tmpl-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                placeholder={
                  "Hi {{lead.owner_name}}, thanks for chatting! Here's that info we discussed: ..."
                }
                required
              />
              <div className="text-muted-foreground flex items-center justify-between text-xs">
                <span>
                  {body.length} chars · ~{segments} segment
                  {segments === 1 ? "" : "s"} (incl. opt-out)
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                &ldquo;Reply STOP to opt out.&rdquo; is added automatically.
                Variables:{" "}
                <code className="text-[11px]">{"{{lead.company}}"}</code>,{" "}
                <code className="text-[11px]">{"{{lead.owner_name}}"}</code>,{" "}
                <code className="text-[11px]">{"{{owner.full_name}}"}</code>.
                Anything unknown is left blank.
              </p>
            </div>
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
              {pending
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Create template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
