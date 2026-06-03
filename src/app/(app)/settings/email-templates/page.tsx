import { Mail } from "lucide-react";
import { redirect } from "next/navigation";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

import { DeleteEmailTemplateDialog } from "./delete-email-template-dialog";
import { EmailTemplateFormDialog } from "./email-template-form-dialog";

export default async function SettingsEmailTemplatesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: templates }, { data: campaigns }] = await Promise.all([
    supabase
      .from("email_templates")
      .select("id, name, subject, body, last_used_at, created_at")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("campaigns")
      .select("id, email_template_id, status")
      .neq("status", "ended"),
  ]);

  const usageByTemplate = new Map<string, number>();
  for (const c of campaigns ?? []) {
    if (!c.email_template_id) continue;
    usageByTemplate.set(
      c.email_template_id,
      (usageByTemplate.get(c.email_template_id) ?? 0) + 1,
    );
  }

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Email templates
          </h1>
          <p className="text-muted-foreground text-sm">
            The emails the AI can send on a call. Attach one to a campaign
            (Booking section) so its &ldquo;send email&rdquo; tool knows what to
            send.
          </p>
        </div>
        <EmailTemplateFormDialog mode="create" />
      </div>

      {templates && templates.length > 0 ? (
        <div className="border-border overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="w-[160px]">Used by</TableHead>
                <TableHead className="w-[180px]" aria-label="Row actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((tmpl) => {
                const usage = usageByTemplate.get(tmpl.id) ?? 0;
                return (
                  <TableRow key={tmpl.id} className="group">
                    <TableCell className="text-foreground text-sm font-medium">
                      {tmpl.name}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-[320px] truncate text-sm">
                      {tmpl.subject}
                    </TableCell>
                    <TableCell>
                      {usage > 0 ? (
                        <span className="text-foreground text-xs tabular-nums">
                          {usage} campaign{usage === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          Not in use
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="ml-auto flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                        <EmailTemplateFormDialog
                          mode="edit"
                          template={{
                            id: tmpl.id,
                            name: tmpl.name,
                            subject: tmpl.subject,
                            body: tmpl.body,
                          }}
                        />
                        <DeleteEmailTemplateDialog
                          template={{ id: tmpl.id, name: tmpl.name }}
                          usageCount={usage}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Mail className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">
            No email templates yet
          </p>
          <p className="text-muted-foreground max-w-sm text-sm">
            Create one, then attach it to a campaign so the AI can email leads
            during a call.
          </p>
          <div className="mt-2">
            <EmailTemplateFormDialog
              mode="create"
              triggerLabel="Create your first template"
            />
          </div>
        </div>
      )}
    </div>
  );
}
