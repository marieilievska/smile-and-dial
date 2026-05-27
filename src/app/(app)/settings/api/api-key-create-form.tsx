"use client";

import { Copy } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createApiKey } from "@/lib/api-keys/actions";

export function ApiKeyCreateForm() {
  const [name, setName] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    if (!name.trim()) {
      toast.error("Give the key a name first.");
      return;
    }
    startTransition(async () => {
      const result = await createApiKey({ name });
      if (result.error || !result.key) {
        toast.error(result.error ?? "Could not create the key.");
        return;
      }
      setCreatedKey(result.key.rawKey);
      setName("");
      toast.success(`Key created: ${result.key.name}.`);
    });
  }

  function copyKey() {
    if (!createdKey) return;
    navigator.clipboard.writeText(createdKey).then(
      () => toast.success("Copied."),
      () => toast.error("Copy failed."),
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {createdKey ? (
        <div
          className="border-border bg-muted/40 flex flex-col gap-2 rounded-md border p-3"
          data-testid="api-key-shown"
        >
          <p className="text-foreground text-sm font-medium">
            Copy this now — it won&apos;t be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="bg-background flex-1 truncate rounded border p-2 font-mono text-xs">
              {createdKey}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copyKey}
              data-testid="api-key-copy"
            >
              <Copy className="size-3" /> Copy
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCreatedKey(null)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="api-key-name">Key name</Label>
          <Input
            id="api-key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Partner X webhook"
          />
        </div>
        <Button
          type="button"
          onClick={submit}
          disabled={pending}
          data-testid="api-key-create-submit"
        >
          {pending ? "Creating…" : "Create key"}
        </Button>
      </div>
    </div>
  );
}
