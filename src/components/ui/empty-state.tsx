import { cn } from "@/lib/utils";

/** Shared empty-state primitive. Round 29 — every list page had been
 *  inventing its own empty state. Consolidated here so all of them
 *  share spacing, type weight, and copy rhythm: dashed border, soft
 *  icon, headline (sentence case), helper (one line), optional CTA
 *  cluster.
 *
 *  Two variants:
 *   - default: "you don't have any X yet" (first-run state)
 *   - filtered: "no X match your current filters" (searches that
 *     returned nothing)
 *
 *  Pages that want different visuals (e.g. the empty pipeline board)
 *  can still roll their own — this is just the default. */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  variant = "default",
  className,
  ...rest
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  variant?: "default" | "filtered";
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "title">) {
  return (
    <div
      {...rest}
      className={cn(
        "border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center",
        className,
      )}
      data-variant={variant}
    >
      <span className="text-muted-foreground inline-flex size-8 items-center justify-center">
        {icon}
      </span>
      <p className="text-foreground text-sm font-medium">{title}</p>
      {description ? (
        <p className="text-muted-foreground max-w-sm text-sm">{description}</p>
      ) : null}
      {actions ? (
        <div className="mt-2 flex items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
