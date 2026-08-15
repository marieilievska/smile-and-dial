"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { deleteTemplate } from "@/lib/agents/template-actions";

export function DeleteTemplateButton({
  id,
  name,
}: {
  id: string;
  name: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={`Delete ${name}`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await deleteTemplate(id);
          if (r.error) toast.error(r.error);
          else {
            toast.success("Template deleted.");
            router.refresh();
          }
        })
      }
    >
      <Trash2 className="size-4" />
    </Button>
  );
}
