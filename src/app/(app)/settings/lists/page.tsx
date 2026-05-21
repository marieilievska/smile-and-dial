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

import { DeleteListDialog } from "./delete-list-dialog";
import { ListFormDialog } from "./list-form-dialog";

export default async function ListsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: lists } = await supabase
    .from("lists")
    .select("id, name, description, created_at")
    .order("created_at", { ascending: true });

  return (
    <div className="p-8">
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

      {lists && lists.length > 0 ? (
        <div className="border-border mt-6 overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lists.map((list) => (
                <TableRow key={list.id}>
                  <TableCell className="font-medium">{list.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {list.description || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(list.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <ListFormDialog mode="edit" list={list} />
                      <DeleteListDialog list={list} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border mt-6 flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
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
