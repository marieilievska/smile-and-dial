import { BookOpen, FileText } from "lucide-react";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
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

  const now = new Date();

  return (
    <div className="flex flex-col gap-6 p-8">
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
        <div className="border-border overflow-hidden rounded-lg border">
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
              {kbs.map((kb) => {
                const sourceCount = kb.sources.length;
                return (
                  <TableRow key={kb.id} className="group">
                    <TableCell className="font-medium">{kb.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {kb.description || "—"}
                    </TableCell>
                    <TableCell>
                      {sourceCount > 0 ? (
                        <Badge
                          variant="secondary"
                          className="inline-flex items-center gap-1"
                        >
                          <FileText className="size-3" />
                          {sourceCount}{" "}
                          {sourceCount === 1 ? "source" : "sources"}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground tabular-nums"
                      title={new Date(kb.created_at).toLocaleString()}
                    >
                      {formatCreatedAt(kb.created_at, now)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <KbSourcesDialog
                          kb={{ id: kb.id, name: kb.name }}
                          sources={kb.sources}
                        />
                        <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <KbFormDialog mode="edit" kb={kb} />
                          <DeleteKbDialog kb={{ id: kb.id, name: kb.name }} />
                        </div>
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
