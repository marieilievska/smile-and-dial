"use client";

import { FileText, Mail, Pencil, Plus, Type } from "lucide-react";
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
  createEmailTemplate,
  updateEmailTemplate,
} from "@/lib/email-templates/actions";

import { DialogSection } from "../dialog-section";

export type EmailTemplateData = {
  id: string;
  name: string;
  subject: string;
  body: string;
};

/** Create/edit dialog for /settings/email-templates. The send_email tool
 *  sends the campaign's chosen template verbatim, filling {{variables}} from
 *  the lead. */
export function EmailTemplateFormDialog({
  mode,
  template,
  triggerLabel,
}: {
  mode: "create" | "edit";
  template?: EmailTemplateData;
  triggerLabel?: string;
}) {
  const isEdit = mode === "edit";
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(template?.name ?? "");
  const [subject, setSubject] = useState(template?.subject ?? "");
  const [body, setBody] = useState(template?.body ?? "");

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const result =
          isEdit && template
            ? await updateEmailTemplate(template.id, name, subject, body)
            : await createEmailTemplate(name, subject, body);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success(isEdit ? "Template updated." : "Template created.");
          setOpen(false);
          if (!isEdit) {
            setName("");
            setSubject("");
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
            {isEdit ? "Edit email template" : "New email template"}
          </DialogTitle>
          <DialogDescription>
            The exact email the AI sends when it uses the send-email tool.
            Attach it to a campaign under the campaign&apos;s Booking section.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogSection
            icon={<FileText className="size-3.5" />}
            title="Name"
            description="Internal label — shown in the campaign template picker."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tmpl-name">Name</Label>
              <Input
                id="tmpl-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Demo follow-up"
                required
              />
            </div>
          </DialogSection>

          <DialogSection
            icon={<Type className="size-3.5" />}
            title="Subject"
            description="The email subject line. Variables work here too."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tmpl-subject">Subject</Label>
              <Input
                id="tmpl-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Great talking with {{lead.company}} — here's that info"
                required
              />
            </div>
          </DialogSection>

          <DialogSection
            icon={<Mail className="size-3.5" />}
            title="Body"
            description="The message body. Insert lead details with {{variables}}."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tmpl-body">Body</Label>
              <Textarea
                id="tmpl-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
                placeholder={
                  "Hi {{lead.owner_name}},\n\nThanks for chatting just now. As promised, here's a quick overview...\n\n— {{owner.full_name}}"
                }
                required
              />
              <p className="text-muted-foreground text-xs">
                Variables:{" "}
                <code className="text-[11px]">{"{{lead.company}}"}</code>,{" "}
                <code className="text-[11px]">{"{{lead.owner_name}}"}</code>,{" "}
                <code className="text-[11px]">{"{{lead.city}}"}</code>,{" "}
                <code className="text-[11px]">{"{{lead.business_email}}"}</code>
                , <code className="text-[11px]">{"{{owner.full_name}}"}</code>.
                Anything unknown is left blank.
              </p>
              <p className="text-muted-foreground text-xs">
                Paste a link as-is. On send we attach the lead&rsquo;s business
                details to it and shorten it.
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
