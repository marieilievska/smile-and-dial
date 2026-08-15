import Link from "next/link";
import { ArrowRight, PencilRuler } from "lucide-react";

import { Breadcrumbs } from "@/components/app-shell/breadcrumbs";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";

export function TemplateGallery() {
  return (
    <div className="flex flex-col gap-5 p-6">
      <Breadcrumbs
        items={[
          { label: "Settings", href: "/settings/overview" },
          { label: "Agents", href: "/settings/agents" },
          { label: "New agent" },
        ]}
      />
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Build agent
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Start from a proven template — the behavior&apos;s already dialed in,
          you just write the script.
        </p>
      </div>

      <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
        {AGENT_TEMPLATES.map((t) => (
          <Link
            key={t.key}
            href={`/settings/agents/new/${t.key}`}
            className="border-border hover:border-foreground/20 hover:bg-muted/30 group flex flex-col gap-1 rounded-2xl border p-5 transition-colors"
          >
            <span className="text-foreground flex items-center justify-between text-sm font-semibold">
              {t.name}
              <ArrowRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" />
            </span>
            <span className="text-muted-foreground text-xs">
              {t.description}
            </span>
          </Link>
        ))}
      </div>

      <Link
        href="/settings/agents/new/scratch"
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-xs"
      >
        <PencilRuler className="size-3.5" />
        Advanced — build from scratch
      </Link>
    </div>
  );
}
