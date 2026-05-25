"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateElevenLabsSettings } from "@/lib/integrations/actions";

export function ElevenLabsForm({
  hasApiKey,
  voiceIds,
}: {
  hasApiKey: boolean;
  voiceIds: string;
}) {
  const [apiKey, setApiKey] = useState("");
  const [voices, setVoices] = useState(voiceIds);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const result = await updateElevenLabsSettings({
          apiKey,
          voiceIds: voices,
        });
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success("ElevenLabs settings saved.");
          setApiKey("");
        }
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="el-api-key">API key</Label>
        <Input
          id="el-api-key"
          type="password"
          value={apiKey}
          placeholder={
            hasApiKey
              ? "A key is saved — enter a new one to replace it"
              : "Paste your ElevenLabs API key"
          }
          onChange={(event) => setApiKey(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="el-voice-ids">Allowed voice IDs</Label>
        <Textarea
          id="el-voice-ids"
          value={voices}
          rows={3}
          placeholder="Comma-separated ElevenLabs voice IDs"
          onChange={(event) => setVoices(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          These populate the voice picker in the Agent Builder.
        </p>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
