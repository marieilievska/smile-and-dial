"use client";

import { useState, useTransition } from "react";
import { FileText, Link2, Trash2 } from "lucide-react";
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
} from "@/lib/knowledge-bases/actions";
import { createClient } from "@/lib/supabase/client";

export type KbSource = {
  id: string;
  type: "file" | "url";
  file_path: string | null;
  url: string | null;
  synced_at: string | null;
};

const BUCKET = "knowledge-base-files";

function sourceLabel(source: KbSource): string {
  if (source.type === "url") return source.url ?? "";
  return source.file_path?.split("/").pop() ?? "File";
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

  function addUrl() {
    startTransition(async () => {
      const result = await addUrlSource(kb.id, url);
      if (result.error) toast.error(result.error);
      else {
        toast.success("URL added.");
        setUrl("");
      }
    });
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;

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
      else toast.success("File added.");
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
            Add files and URLs for the AI agent to draw on.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {sources.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {sources.map((source) => (
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
                    title={sourceLabel(source)}
                  >
                    {sourceLabel(source)}
                  </span>
                  <Badge variant="secondary">
                    {source.synced_at ? "Synced" : "Not synced"}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${sourceLabel(source)}`}
                    disabled={pending}
                    onClick={() => remove(source.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">No sources yet.</p>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="kb-url">Add a URL</Label>
            <div className="flex gap-2">
              <Input
                id="kb-url"
                value={url}
                placeholder="https://…"
                onChange={(event) => setUrl(event.target.value)}
              />
              <Button onClick={addUrl} disabled={pending || !url.trim()}>
                Add
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="kb-file">Upload a file</Label>
            <Input
              id="kb-file"
              type="file"
              onChange={onFile}
              disabled={uploading}
            />
            {uploading ? (
              <p className="text-muted-foreground text-sm">Uploading…</p>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
