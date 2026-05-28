"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** Hover-revealed click-to-copy button for a phone number. The number
 *  itself remains plain text inside the table cell (so the cell's
 *  accessible name is just the phone), and this icon-only button sits
 *  beside it for the operator who needs to paste the number into a
 *  CRM or a chat. Tooltip flips to a green check for 1.5s on copy. */
export function CopyPhoneButton({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(phone);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts. Ignore — the
      // operator can still triple-click and copy by hand.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `Copied ${phone}` : `Copy ${phone}`}
      title={copied ? "Copied" : "Copy"}
      className="text-muted-foreground hover:text-foreground hover:bg-muted/60 inline-flex size-6 items-center justify-center rounded-md opacity-0 transition-all group-hover:opacity-100 focus-visible:opacity-100"
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}
