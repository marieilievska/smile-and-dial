import { BookOpen } from "lucide-react";
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

import { DeleteKbDialog } from "./delete-kb-dialog";
import { KbFormDialog } from "./kb-form-dialog";
import { KbSourcesDialog, type KbSource } from "./kb-sources-dialog";

export default async function KnowledgeBasesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data } = await supabase
    .from("knowledge_bases")
    .select(
      "id, name, description, created_at, knowledge_base_sources(id, type, file_path, url, synced_at, created_at)",
    )
    .order("created_at", { ascending: true });

  const kbs = (data ?? []).map((kb) => ({
    id: kb.id,
    name: kb.name,
    description: kb.description,
    created_at: kb.created_at,
    sources: [...(kb.knowledge_base_sources ?? [])]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(
        (s): KbSource => ({
          id: s.id,
          type: s.type as "file" | "url",
          file_path: s.file_path,
          url: s.url,
          synced_at: s.synced_at,
        }),
      ),
  }));

  return (
    <div className="p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Knowledge bases
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Reference material — files and URLs — your AI agents can draw on
            during calls.
          </p>
        </div>
        <KbFormDialog mode="create" />
      </div>

      {kbs.length > 0 ? (
        <div className="border-border mt-6 overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Sources</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-64" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {kbs.map((kb) => (
                <TableRow key={kb.id}>
                  <TableCell className="font-medium">{kb.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {kb.description || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {kb.sources.length}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(kb.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <KbSourcesDialog
                        kb={{ id: kb.id, name: kb.name }}
                        sources={kb.sources}
                      />
                      <KbFormDialog mode="edit" kb={kb} />
                      <DeleteKbDialog kb={{ id: kb.id, name: kb.name }} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border mt-6 flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <BookOpen className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">
            No knowledge bases yet
          </p>
          <p className="text-muted-foreground text-sm">
            Create one to give your AI agents reference material.
          </p>
        </div>
      )}
    </div>
  );
}
