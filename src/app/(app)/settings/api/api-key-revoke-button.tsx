"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { revokeApiKey } from "@/lib/api-keys/actions";

export function ApiKeyRevokeButton({ apiKeyId }: { apiKeyId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await revokeApiKey({ apiKeyId });
          if (r.error) toast.error(r.error);
          else toast.success("Revoked.");
        })
      }
      data-testid="api-key-revoke"
    >
      Revoke
    </Button>
  );
}
