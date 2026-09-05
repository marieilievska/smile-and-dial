"use client";

import { useState, useTransition } from "react";
import { FileText, Link2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addFileSource,
  addUrlSource,
  removeSource,
  retryKnowledgeBaseSync,
} from "@/lib/knowledge-bases/actions";
import {
  KNOWLEDGE_FILE_ACCEPT,
  knowledgeSourceName,
  sourceSyncState,
  validateKnowledgeFile,
} from "@/lib/knowledge-bases/rules";
import { createClient } from "@/lib/supabase/client";

export type KbSource = {
  id: string;
  type: "file" | "url";
  file_path: string | null;
  url: string | null;
  synced_at: string | null;
  elevenlabs_document_id: string | null;
  sync_error: string | null;
};

const BUCKET = "knowledge-base-files";

/** The truthful sync pill: a source is only useful to an agent once
 *  ElevenLabs holds its document. */
function SyncBadge({ source }: { source: KbSource }) {
  const state = sourceSyncState(source);
  if (state === "synced") return <Badge variant="success">Synced</Badge>;
  if (state === "error") {
    return (
      <Badge
        variant="destructive"
        title={source.sync_error ?? "The ElevenLabs upload failed."}
      >
        Sync failed
      </Badge>
    );
  }
  return (
    <Badge variant="warning" title="Not uploaded to ElevenLabs yet.">
      Not synced
    </Badge>
  );
}

export function KbSourcesDialog({
  kb,
  sources,
}: {
  kb: { id: string; name: string };
  sources: KbSource[];
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [syncing, startSync] = useTransition();

  const unsyncedCount = sources.filter(
    (s) => sourceSyncState(s) !== "synced",
  ).length;

  function addUrl() {
    startTransition(async () => {
      const result = await addUrlSource(kb.id, url);
      if (result.error) toast.error(result.error);
      else {
        if (result.warning) toast.warning(result.warning);
        else toast.success("URL added and synced.");
        setUrl("");
      }
    });
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;

    const invalid = validateKnowledgeFile(file);
    if (invalid) {
      toast.error(invalid);
      input.value = "";
      return;
    }

    setUploading(true);
    try {
      const supabase = createClient();
      const path = `${kb.id}/${crypto.randomUUID()}/${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, file);
      if (uploadError) {
        toast.error("Could not upload that file.");
        return;
      }
      const result = await addFileSource(kb.id, path);
      if (result.error) toast.error(result.error);
      else if (result.warning) toast.warning(result.warning);
      else toast.success("File added and synced.");
    } finally {
      setUploading(false);
      input.value = "";
    }
  }

  function remove(sourceId: string) {
    startTransition(async () => {
      const result = await removeSource(sourceId);
      if (result.error) toast.error(result.error);
    });
  }

  function sync() {
    startSync(async () => {
      const result = await retryKnowledgeBaseSync(kb.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      const failed = result.failed ?? 0;
      const synced = result.synced ?? 0;
      if (failed > 0) {
        toast.warning(
          `${synced} synced, ${failed} still failing. Hover a "Sync failed" pill for the reason.`,
        );
      } else {
        toast.success(
          synced === 1
            ? "1 source synced to ElevenLabs."
            : `${synced} sources synced to ElevenLabs.`,
        );
      }
    });
  }

  const busy = pending || syncing || uploading;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <FileText className="size-4" />
          Sources
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sources — {kb.name}</DialogTitle>
          <DialogDescription>
            Add files and URLs for the AI agent to draw on. Each source is
            uploaded to ElevenLabs and attached to every agent that uses this
            knowledge base.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {sources.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {sources.map((source) => {
                const label = knowledgeSourceName(source);
                return (
                  <li
                    key={source.id}
                    className="border-border flex items-center gap-2 rounded-lg border px-3 py-2"
                  >
                    {source.type === "url" ? (
                      <Link2 className="text-muted-foreground size-4 shrink-0" />
                    ) : (
                      <FileText className="text-muted-foreground size-4 shrink-0" />
                    )}
                    <span
                      className="text-foreground flex-1 truncate text-sm"
                      title={label}
                    >
                      {label}
                    </span>
                    <SyncBadge source={source} />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${label}`}
                      disabled={busy}
                      onClick={() => remove(source.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">No sources yet.</p>
          )}

          {unsyncedCount > 0 ? (
            <div className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <p className="text-muted-foreground text-xs">
                {unsyncedCount === 1
                  ? "1 source isn't on ElevenLabs yet, so agents can't use it."
                  : `${unsyncedCount} sources aren't on ElevenLabs yet, so agents can't use them.`}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={sync}
                disabled={busy}
                aria-label="Sync sources to ElevenLabs"
              >
                <RefreshCw
                  className={`size-4 ${syncing ? "animate-spin" : ""}`}
                />
                {syncing ? "Syncing…" : "Sync"}
              </Button>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="kb-url">Add a URL</Label>
            <div className="flex gap-2">
              <Input
                id="kb-url"
                value={url}
                placeholder="https://…"
                onChange={(event) => setUrl(event.target.value)}
              />
              <Button onClick={addUrl} disabled={busy || !url.trim()}>
                Add
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="kb-file">Upload a file</Label>
            <Input
              id="kb-file"
              type="file"
              accept={KNOWLEDGE_FILE_ACCEPT}
              onChange={onFile}
              disabled={busy}
            />
            <p className="text-muted-foreground text-xs">
              {uploading
                ? "Uploading…"
                : "PDF, TXT, MD, DOCX or HTML, up to 10 MB."}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
