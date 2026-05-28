import { FolderPlus, Link2, ListChecks } from "lucide-react";
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

import { formatCreatedAt } from "../format-created";
import { DeleteListDialog } from "./delete-list-dialog";
import { ListAttachmentControls } from "./list-attachment-controls";
import { ListFormDialog } from "./list-form-dialog";

export default async function ListsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: lists }, { data: campaigns }, { data: attachments }] =
    await Promise.all([
      supabase
        .from("lists")
        .select("id, name, description, created_at")
        .order("created_at", { ascending: true }),
      supabase
        .from("campaigns")
        .select("id, name, status")
        .neq("status", "ended")
        .order("name"),
      supabase
        .from("list_campaign_attachments")
        .select("list_id, campaign:campaigns(id, name)")
        .is("detached_at", null),
    ]);

  const campaignByList = new Map<string, { id: string; name: string }>();
  (attachments ?? []).forEach((row) => {
    if (row.campaign) {
      campaignByList.set(row.list_id, {
        id: row.campaign.id,
        name: row.campaign.name,
      });
    }
  });

  const activeCampaigns = (campaigns ?? []).map((c) => ({
    id: c.id,
    name: c.name,
  }));

  const totalLists = lists?.length ?? 0;
  const attachedCount = (lists ?? []).filter((l) =>
    campaignByList.has(l.id),
  ).length;
  const unattachedCount = totalLists - attachedCount;
  const now = new Date();

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Lists
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Group leads into lists. A list is what gets attached to a campaign.
          </p>
        </div>
        <ListFormDialog mode="create" />
      </div>

      {totalLists > 0 ? (
        <>
          <section
            data-testid="lists-stat-strip"
            className="border-border bg-card grid grid-cols-3 gap-x-4 gap-y-3 rounded-xl border px-5 py-4"
          >
            <StatTile
              icon={<ListChecks className="size-3.5" />}
              label="Total lists"
              value={totalLists.toLocaleString()}
            />
            <StatTile
              icon={<Link2 className="size-3.5" />}
              label="Attached to a campaign"
              value={attachedCount.toLocaleString()}
              divider
            />
            <StatTile
              icon={<FolderPlus className="size-3.5" />}
              label="Unattached"
              value={unattachedCount.toLocaleString()}
              divider
            />
          </section>

          <div className="border-border overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-56" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(lists ?? []).map((list) => {
                  const attached = campaignByList.get(list.id) ?? null;
                  return (
                    <TableRow key={list.id} className="group">
                      <TableCell className="font-medium">{list.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {list.description || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {attached ? attached.name : "—"}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground tabular-nums"
                        title={new Date(list.created_at).toLocaleString()}
                      >
                        {formatCreatedAt(list.created_at, now)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <ListAttachmentControls
                            list={{ id: list.id, name: list.name }}
                            attachedCampaign={attached}
                            campaigns={activeCampaigns}
                          />
                          <ListFormDialog mode="edit" list={list} />
                          <DeleteListDialog list={list} />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <FolderPlus className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">No lists yet</p>
          <p className="text-muted-foreground text-sm">
            Create your first list to start grouping leads.
          </p>
        </div>
      )}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  divider,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  divider?: boolean;
}) {
  return (
    <div
      className={`-mx-2 flex flex-col gap-1 rounded-lg px-2 py-1 ${
        divider ? "sm:border-border/60 sm:border-l sm:pl-4" : ""
      }`}
    >
      <p className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.16em] uppercase">
        <span className="text-[color:var(--coral)]">{icon}</span>
        {label}
      </p>
      <p className="text-foreground text-2xl leading-none font-medium tabular-nums">
        {value}
      </p>
    </div>
  );
}
