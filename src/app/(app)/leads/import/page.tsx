import { redirect } from "next/navigation";

import { Breadcrumbs } from "@/components/app-shell/breadcrumbs";
import { createClient } from "@/lib/supabase/server";

import { ImportWizard } from "./import-wizard";

// Large imports run as batched server actions from this route; give them the
// full function budget so a slow Twilio-lookup batch can't hit the default
// timeout. (Each browser-driven batch is 500 rows; this is the per-call cap.)
export const maxDuration = 300;

export default async function ImportLeadsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: lists }, { data: customFields }, { data: attachmentRows }] =
    await Promise.all([
      supabase.from("lists").select("id, name").order("name"),
      supabase
        .from("custom_field_defs")
        .select("id, name")
        .order("sort_order", { ascending: true }),
      // Which lists already have an *active* campaign attached? The Done
      // step uses this to tell the user whether Autopilot will start
      // dialing the freshly-imported leads, or whether they still need to
      // attach a campaign first.
      supabase
        .from("list_campaign_attachments")
        .select("list_id, campaign:campaigns(status)")
        .is("detached_at", null),
    ]);

  type AttachmentJoin = {
    list_id: string;
    campaign: { status: string } | null;
  };
  const activeCampaignListIds = [
    ...new Set(
      ((attachmentRows ?? []) as unknown as AttachmentJoin[])
        .filter((r) => r.campaign?.status === "active")
        .map((r) => r.list_id),
    ),
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-8">
      <Breadcrumbs
        items={[{ label: "Leads", href: "/leads" }, { label: "Import" }]}
      />
      <header className="flex flex-col gap-1.5">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Import leads
        </h1>
        <p className="text-muted-foreground text-sm">
          Bring leads into Smile &amp; Dial. We&apos;ll verify every phone
          number with Twilio and skip the ones we can&apos;t legally call.
        </p>
      </header>
      <ImportWizard
        lists={lists ?? []}
        customFields={customFields ?? []}
        activeCampaignListIds={activeCampaignListIds}
      />
    </div>
  );
}
