"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { updateElevenLabsSettings } from "@/lib/integrations/actions";

/** Settings → Integrations → ElevenLabs panel.
 *
 *  Round L1 — the API key moved into the server env
 *  (`ELEVENLABS_API_KEY`) since Smile & Dial uses a single ElevenLabs
 *  account behind the whole product. This form now only manages the
 *  voice-id allowlist, which is per-workspace (different tenants might
 *  want different agent voices). The connection state in the parent
 *  card reads from `process.env.ELEVENLABS_API_KEY` instead of the
 *  database column. */
export function ElevenLabsForm({ voiceIds }: { voiceIds: string }) {
  const [voices, setVoices] = useState(voiceIds);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const result = await updateElevenLabsSettings({ voiceIds: voices });
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success("ElevenLabs settings saved.");
        }
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
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
          These populate the voice picker in the Agent Builder. The ElevenLabs
          API key for the whole product lives in the server environment (
          <code>ELEVENLABS_API_KEY</code>) and isn&apos;t configured here.
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
