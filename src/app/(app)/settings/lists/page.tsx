import { FolderPlus } from "lucide-react";
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
        .select("list_id, campaign:campaigns(id, name, status)")
        .is("detached_at", null),
    ]);

  // A list can now be attached to more than one active campaign (shared
  // lists), so collect ALL of a list's active attachments rather than
  // collapsing to one — a single-campaign Map here would silently keep only
  // the last attachment row for a shared list and hide the rest. Skip ended
  // campaigns: a campaign can be ended without detaching its list, and a dead
  // campaign shouldn't inflate the "Shared" / "Detach all" count (the sibling
  // activeCampaigns query already excludes ended). status is dropped here — the
  // controls only need id + name.
  const campaignsByList = new Map<string, { id: string; name: string }[]>();
  (attachments ?? []).forEach((row) => {
    if (row.campaign && row.campaign.status !== "ended") {
      const existing = campaignsByList.get(row.list_id) ?? [];
      existing.push({ id: row.campaign.id, name: row.campaign.name });
      campaignsByList.set(row.list_id, existing);
    }
  });
  // Stable, name-sorted order so "Shared: A, B" (here and in the controls)
  // doesn't reshuffle between loads on the same underlying attachments.
  for (const arr of campaignsByList.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }

  const activeCampaigns = (campaigns ?? []).map((c) => ({
    id: c.id,
    name: c.name,
  }));

  const totalLists = lists?.length ?? 0;
  const now = new Date();

  return (
    <div className="flex flex-col gap-5 p-6">
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
          {/* Round 29 — dropped the lists stat strip. Total / attached /
           *  unattached counts weren't urgent enough to justify the
           *  chrome tax on every settings visit. The same numbers live
           *  inline in the table footer or via the campaign count
           *  column. */}
          <div className="border-border overflow-hidden rounded-2xl border shadow-sm">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Campaigns</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-56" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(lists ?? []).map((list) => {
                  const attached = campaignsByList.get(list.id) ?? [];
                  return (
                    <TableRow key={list.id} className="group">
                      <TableCell className="font-medium">{list.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {list.description || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {attached.length > 0
                          ? attached.map((c) => c.name).join(", ")
                          : "—"}
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
                            attachedCampaigns={attached}
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
        <div className="border-border flex flex-col items-center gap-2 rounded-2xl border border-dashed py-16 text-center">
          <FolderPlus className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">No lists yet</p>
          <p className="text-muted-foreground text-sm">
            Create your first list to start grouping leads.
          </p>
          <div className="mt-2">
            <ListFormDialog
              mode="create"
              triggerLabel="Create your first list"
            />
          </div>
        </div>
      )}
    </div>
  );
}
