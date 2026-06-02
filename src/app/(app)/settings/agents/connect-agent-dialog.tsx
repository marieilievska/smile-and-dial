"use client";

import { Link2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectAgent } from "@/lib/agents/actions";

/** Connect an agent that already exists in ElevenLabs by pasting its agent
 *  ID. Reference-only — we never modify the ElevenLabs agent. */
export function ConnectAgentDialog() {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onConnect() {
    startTransition(async () => {
      const result = await connectAgent({ elevenlabsAgentId: agentId });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Agent connected.");
      setAgentId("");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="connect-agent">
          <Link2 className="size-4" />
          Connect existing
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect an existing ElevenLabs agent</DialogTitle>
          <DialogDescription>
            Already built an agent in ElevenLabs? Paste its agent ID to use it
            in campaigns. We link to it as-is and never change its configuration
            — it keeps the prompt, voice, tools, and webhooks you set up there.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="connect-agent-id">ElevenLabs agent ID</Label>
          <Input
            id="connect-agent-id"
            placeholder="agent_xxxxxxxxxxxxxxxxxxxxxxxxxx"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            autoComplete="off"
            data-testid="connect-agent-id"
          />
          <p className="text-muted-foreground text-xs">
            Find it in ElevenLabs under your agent&apos;s settings (the
            &ldquo;Agent ID&rdquo;).
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={pending || !agentId.trim()}
            onClick={onConnect}
          >
            {pending ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
