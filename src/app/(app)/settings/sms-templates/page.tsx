import { MessageSquare } from "lucide-react";
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

import { DeleteSmsTemplateDialog } from "./delete-sms-template-dialog";
import { SmsTemplateFormDialog } from "./sms-template-form-dialog";

export default async function SettingsSmsTemplatesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: templates }, { data: campaigns }] = await Promise.all([
    supabase
      .from("sms_templates")
      .select("id, name, body, last_used_at, created_at")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("campaigns")
      .select("id, sms_template_id, status")
      .neq("status", "ended"),
  ]);

  const usageByTemplate = new Map<string, number>();
  for (const c of campaigns ?? []) {
    if (!c.sms_template_id) continue;
    usageByTemplate.set(
      c.sms_template_id,
      (usageByTemplate.get(c.sms_template_id) ?? 0) + 1,
    );
  }

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Text templates
          </h1>
          <p className="text-muted-foreground text-sm">
            The texts the AI can send on a call. Attach one to a campaign
            (Booking section) so its &ldquo;send text&rdquo; tool knows what to
            send. Texts go to a confirmed mobile and always include an opt-out.
          </p>
        </div>
        <SmsTemplateFormDialog mode="create" />
      </div>

      {templates && templates.length > 0 ? (
        <div className="border-border overflow-hidden rounded-2xl border shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Message</TableHead>
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
                      {tmpl.body}
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
                        <SmsTemplateFormDialog
                          mode="edit"
                          template={{
                            id: tmpl.id,
                            name: tmpl.name,
                            body: tmpl.body,
                          }}
                        />
                        <DeleteSmsTemplateDialog
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
        <div className="border-border flex flex-col items-center gap-2 rounded-2xl border border-dashed py-16 text-center">
          <MessageSquare className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">
            No text templates yet
          </p>
          <p className="text-muted-foreground max-w-sm text-sm">
            Create one, then attach it to a campaign so the AI can text leads
            during a call.
          </p>
          <div className="mt-2">
            <SmsTemplateFormDialog
              mode="create"
              triggerLabel="Create your first template"
            />
          </div>
        </div>
      )}
    </div>
  );
}
