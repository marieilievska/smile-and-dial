"use client";

import { Check, Link2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

/** Admin-only "Copy share link" for the public read-only reporting view.
 *  Builds the link from the current origin so it works on whichever domain
 *  the admin is on; the token gates access (revocable from settings). */
export function CopyShareLinkButton({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const url = `${window.location.origin}/share/reporting/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Share link copied — anyone with it can view (read-only).");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy. Link: " + url);
    }
  }

  return (
    <Button variant="outline" size="sm" onClick={copy}>
      {copied ? <Check className="size-4" /> : <Link2 className="size-4" />}
      {copied ? "Copied" : "Copy share link"}
    </Button>
  );
}
